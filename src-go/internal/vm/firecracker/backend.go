package firecracker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

const (
	BackendName = "firecracker"
	NetModeNone = "none"
	NetModeTap  = "tap"
)

type Options struct {
	BinaryPath  string
	StateDir    string
	KernelImage string
	NetMode     string
	StopTimeout time.Duration
}

type Backend struct {
	mu       sync.RWMutex
	opts     Options
	runtimes map[string]*runtimeState
}

func NewBackend(opts Options) (*Backend, error) {
	if opts.BinaryPath == "" {
		return nil, errors.New("firecracker backend requires NANOCLAW_GO_FIRECRACKER_BIN")
	}
	if opts.StateDir == "" {
		opts.StateDir = filepath.Join(os.TempDir(), "nanoclaw-go-vm")
	}
	if opts.NetMode == "" {
		opts.NetMode = NetModeNone
	}
	switch opts.NetMode {
	case NetModeNone, NetModeTap:
	default:
		return nil, fmt.Errorf("unsupported firecracker net mode %q", opts.NetMode)
	}
	if opts.StopTimeout <= 0 {
		opts.StopTimeout = 10 * time.Second
	}
	if err := os.MkdirAll(opts.StateDir, 0o755); err != nil {
		return nil, err
	}
	return &Backend{opts: opts, runtimes: map[string]*runtimeState{}}, nil
}

func (b *Backend) Name() string {
	return BackendName
}

func (b *Backend) CreateSandbox(_ context.Context, spec contracts.SandboxSpec) (contracts.SandboxStatus, error) {
	rt, err := b.ensureRuntime(spec.SandboxID)
	if err != nil {
		return contracts.SandboxStatus{}, err
	}
	now := time.Now().UTC()
	status := contracts.SandboxStatus{
		SandboxID:     spec.SandboxID,
		Backend:       b.Name(),
		VMID:          rt.vmID,
		APISocket:     rt.apiSocket,
		ObservedState: "stopped",
		Health:        "ready",
		LastHeartbeat: &now,
	}
	return status, nil
}

func (b *Backend) StartSandbox(ctx context.Context, spec contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	rt, err := b.ensureRuntime(current.SandboxID)
	if err != nil {
		return contracts.SandboxStatus{}, err
	}

	b.mu.Lock()
	if rt.cmd != nil && isRunning(rt.cmd) {
		rt.pid = rt.cmd.Process.Pid
		status := b.applyRuntimeMetadataLocked(current, rt)
		b.mu.Unlock()
		now := time.Now().UTC()
		status.ObservedState = "running"
		status.Health = "healthy"
		status.LastHeartbeat = &now
		if status.StartedAt == nil {
			status.StartedAt = &now
		}
		return status, nil
	}
	runtimeDir := rt.runtimeDir
	apiSocket := rt.apiSocket
	b.mu.Unlock()

	_ = os.Remove(apiSocket)
	cmd, err := launchFirecrackerProcess(b.opts.BinaryPath, runtimeDir, apiSocket)
	if err != nil {
		return contracts.SandboxStatus{}, err
	}

	socketCtx, socketCancel := context.WithTimeout(ctx, 5*time.Second)
	defer socketCancel()
	if err := waitForAPISocket(socketCtx, apiSocket); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, err
	}

	kernelImage := spec.VMProfile.KernelImage
	if kernelImage == "" {
		kernelImage = b.opts.KernelImage
	}
	if kernelImage == "" {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, errors.New("firecracker kernel image is required")
	}
	if spec.VMProfile.RootFSImage == "" {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, errors.New("firecracker rootfs image is required")
	}
	resolvedKernelImage, err := resolveHostPath(kernelImage)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, fmt.Errorf("resolve kernel image path: %w", err)
	}
	resolvedRootFSImage, err := resolveHostPath(spec.VMProfile.RootFSImage)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, fmt.Errorf("resolve rootfs image path: %w", err)
	}

	client := newAPIClient(apiSocket)
	if err := client.configureMachine(ctx, spec.VMProfile.VCPU, spec.VMProfile.MemoryMiB); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, err
	}
	if err := client.configureBootSource(ctx, resolvedKernelImage); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, err
	}
	if err := client.configureRootDrive(ctx, resolvedRootFSImage); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, err
	}
	if err := b.configureNetworking(ctx, spec, rt); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, err
	}
	if err := client.startInstance(ctx); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, err
	}

	waitDone := make(chan struct{})
	b.mu.Lock()
	rt, ok := b.runtimes[current.SandboxID]
	if !ok {
		b.mu.Unlock()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return contracts.SandboxStatus{}, fmt.Errorf("runtime disappeared for sandbox %s", current.SandboxID)
	}
	rt.cmd = cmd
	rt.pid = cmd.Process.Pid
	rt.waitDone = waitDone
	rt.waitErr = nil
	rt.lastExitCode = 0
	status := b.applyRuntimeMetadataLocked(current, rt)
	b.mu.Unlock()

	go b.monitorProcessExit(current.SandboxID, cmd, waitDone)

	now := time.Now().UTC()
	status.ObservedState = "running"
	status.Health = "healthy"
	status.StartedAt = &now
	status.LastHeartbeat = &now
	return status, nil
}

func (b *Backend) StopSandbox(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	b.mu.RLock()
	rt, ok := b.runtimes[current.SandboxID]
	if !ok {
		b.mu.RUnlock()
		return current, nil
	}
	cmd := rt.cmd
	waitDone := rt.waitDone
	apiSocket := rt.apiSocket
	b.mu.RUnlock()

	if cmd != nil {
		shutdownCtx, shutdownCancel := context.WithTimeout(ctx, 2*time.Second)
		_ = newAPIClient(apiSocket).sendCtrlAltDel(shutdownCtx)
		shutdownCancel()

		if waitDone != nil {
			select {
			case <-waitDone:
			case <-time.After(b.opts.StopTimeout):
				_ = cmd.Process.Kill()
				<-waitDone
			case <-ctx.Done():
				return contracts.SandboxStatus{}, ctx.Err()
			}
		}
	}

	b.mu.Lock()
	if latest, ok := b.runtimes[current.SandboxID]; ok {
		current = b.applyRuntimeMetadataLocked(current, latest)
	}
	b.mu.Unlock()

	now := time.Now().UTC()
	current.Backend = b.Name()
	current.ObservedState = "stopped"
	current.Health = "ready"
	current.LastHeartbeat = &now
	return current, nil
}

func (b *Backend) SnapshotSandbox(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	rt, err := b.ensureRuntime(current.SandboxID)
	if err != nil {
		return contracts.SandboxStatus{}, err
	}

	var snapshotRef string
	b.mu.RLock()
	isLive := rt.cmd != nil && isRunning(rt.cmd)
	b.mu.RUnlock()

	if isLive {
		snapshotRef, err = b.createSnapshot(ctx, rt)
		if err != nil {
			return contracts.SandboxStatus{}, err
		}
	} else {
		snapshotDir := filepath.Join(rt.runtimeDir, "snapshots")
		if err := ensureDir(snapshotDir); err != nil {
			return contracts.SandboxStatus{}, err
		}
		stamp := time.Now().UTC().Format("20060102T150405Z")
		snapshotRef = filepath.Join(snapshotDir, stamp+".coldboot")
		if err := os.WriteFile(snapshotRef, []byte("cold-boot snapshot placeholder\n"), 0o644); err != nil {
			return contracts.SandboxStatus{}, err
		}
	}

	b.mu.Lock()
	if latest, ok := b.runtimes[current.SandboxID]; ok {
		latest.snapshotRef = snapshotRef
		current = b.applyRuntimeMetadataLocked(current, latest)
	}
	b.mu.Unlock()

	now := time.Now().UTC()
	current.Backend = b.Name()
	current.SnapshotCount++
	current.SnapshotRef = snapshotRef
	current.LastHeartbeat = &now
	return current, nil
}

func (b *Backend) DestroySandbox(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	stopped, err := b.StopSandbox(ctx, current)
	if err != nil {
		return contracts.SandboxStatus{}, err
	}

	b.mu.Lock()
	rt, ok := b.runtimes[current.SandboxID]
	if ok {
		delete(b.runtimes, current.SandboxID)
	}
	b.mu.Unlock()

	if ok {
		if err := os.RemoveAll(rt.runtimeDir); err != nil {
			return contracts.SandboxStatus{}, err
		}
	}

	now := time.Now().UTC()
	stopped.Backend = b.Name()
	stopped.ObservedState = "destroyed"
	stopped.Health = "terminated"
	stopped.LastHeartbeat = &now
	stopped.PID = 0
	return stopped, nil
}

func (b *Backend) KillSwitch(ctx context.Context, current contracts.SandboxStatus, reason string) (contracts.SandboxStatus, error) {
	stopped, err := b.StopSandbox(ctx, current)
	if err != nil {
		return contracts.SandboxStatus{}, err
	}
	now := time.Now().UTC()
	stopped.Backend = b.Name()
	stopped.ObservedState = "terminated"
	stopped.Health = "quarantined"
	stopped.KillSwitchNote = reason
	stopped.LastHeartbeat = &now
	return stopped, nil
}

func (b *Backend) GetStatus(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if rt, ok := b.runtimes[current.SandboxID]; ok {
		current = b.applyRuntimeMetadataLocked(current, rt)
	}
	current.Backend = b.Name()
	if current.LastHeartbeat == nil {
		now := time.Now().UTC()
		current.LastHeartbeat = &now
	}
	return current, nil
}

func (b *Backend) Summary() map[string]any {
	b.mu.RLock()
	total := len(b.runtimes)
	running := 0
	for _, rt := range b.runtimes {
		if rt.cmd != nil && isRunning(rt.cmd) {
			running++
		}
	}
	b.mu.RUnlock()

	return map[string]any{
		"backend":            b.Name(),
		"simulated":          false,
		"firecracker_bin":    b.opts.BinaryPath,
		"vm_state_dir":       b.opts.StateDir,
		"vm_net_mode":        b.opts.NetMode,
		"vm_stop_timeout_ms": b.opts.StopTimeout.Milliseconds(),
		"runtime_count":      total,
		"running_count":      running,
	}
}

func (b *Backend) monitorProcessExit(sandboxID string, cmd *exec.Cmd, waitDone chan struct{}) {
	err := cmd.Wait()
	code := exitCodeFromErr(err)
	b.mu.Lock()
	if rt, ok := b.runtimes[sandboxID]; ok && rt.cmd == cmd {
		rt.lastExitCode = code
		rt.waitErr = err
		rt.pid = 0
		rt.cmd = nil
		rt.waitDone = nil
	}
	b.mu.Unlock()
	close(waitDone)
}

func (b *Backend) ensureRuntime(sandboxID string) (*runtimeState, error) {
	if sandboxID == "" {
		return nil, errors.New("sandbox id is required")
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	if rt, ok := b.runtimes[sandboxID]; ok {
		return rt, nil
	}

	runtimeDir := filepath.Join(b.opts.StateDir, sandboxID)
	if err := ensureDir(runtimeDir); err != nil {
		return nil, err
	}

	rt := &runtimeState{
		sandboxID:    sandboxID,
		vmID:         vmIDForSandbox(sandboxID),
		runtimeDir:   runtimeDir,
		apiSocket:    filepath.Join(runtimeDir, "firecracker.sock"),
		lastExitCode: 0,
		createdAt:    time.Now().UTC(),
	}
	b.runtimes[sandboxID] = rt
	return rt, nil
}

func (b *Backend) applyRuntimeMetadataLocked(status contracts.SandboxStatus, rt *runtimeState) contracts.SandboxStatus {
	status.Backend = b.Name()
	status.VMID = rt.vmID
	status.APISocket = rt.apiSocket
	status.PID = rt.pid
	status.LastExitCode = rt.lastExitCode
	if rt.snapshotRef != "" {
		status.SnapshotRef = rt.snapshotRef
	}
	return status
}

func vmIDForSandbox(sandboxID string) string {
	sanitized := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		case r >= '0' && r <= '9':
			return r
		case r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, sandboxID)
	if sanitized == "" {
		sanitized = "vm"
	}
	return "vm-" + sanitized
}

func ensureDir(path string) error {
	return os.MkdirAll(path, 0o755)
}

func resolveHostPath(path string) (string, error) {
	if path == "" {
		return "", errors.New("path is required")
	}
	if filepath.IsAbs(path) {
		return path, nil
	}
	return filepath.Abs(path)
}
