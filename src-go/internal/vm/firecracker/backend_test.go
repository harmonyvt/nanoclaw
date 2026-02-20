package firecracker

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

func TestEnsureRuntimeRejectsUnsafeSandboxIDs(t *testing.T) {
	backend, err := NewBackend(Options{
		BinaryPath: "firecracker",
		StateDir:   t.TempDir(),
	})
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}

	invalidIDs := []string{
		"",
		"../escape",
		"..",
		"nested/path",
		`nested\path`,
		"space id",
		"with.dot",
	}
	for _, id := range invalidIDs {
		if _, err := backend.ensureRuntime(id); err == nil {
			t.Fatalf("expected ensureRuntime to reject sandbox id %q", id)
		}
	}

	rt, err := backend.ensureRuntime("sbx-safe_1")
	if err != nil {
		t.Fatalf("expected valid sandbox id to succeed: %v", err)
	}
	wantDir := filepath.Join(backend.opts.StateDir, "sbx-safe_1")
	if rt.runtimeDir != wantDir {
		t.Fatalf("runtimeDir mismatch: got %q want %q", rt.runtimeDir, wantDir)
	}
}

func TestNewBackendRejectsTapNetMode(t *testing.T) {
	_, err := NewBackend(Options{
		BinaryPath: "firecracker",
		StateDir:   t.TempDir(),
		NetMode:    NetModeTap,
	})
	if err == nil {
		t.Fatalf("expected tap net mode to be rejected")
	}
	if err.Error() != `firecracker net mode "tap" is not implemented` {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGetStatusMarksExitedRuntimeAsStoppedError(t *testing.T) {
	backend, err := NewBackend(Options{
		BinaryPath: "firecracker",
		StateDir:   t.TempDir(),
	})
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}

	rt, err := backend.ensureRuntime("sbx-crash")
	if err != nil {
		t.Fatalf("ensureRuntime: %v", err)
	}

	backend.mu.Lock()
	rt.pid = 0
	rt.cmd = nil
	rt.lastExitCode = 137
	backend.mu.Unlock()

	current := contracts.SandboxStatus{
		SandboxID:     "sbx-crash",
		ObservedState: "running",
		Health:        "healthy",
	}
	status, err := backend.GetStatus(context.Background(), current)
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}

	if status.ObservedState != "stopped" {
		t.Fatalf("expected observed_state stopped, got %q", status.ObservedState)
	}
	if status.Health != "error" {
		t.Fatalf("expected health error, got %q", status.Health)
	}
	if status.PID != 0 {
		t.Fatalf("expected pid 0, got %d", status.PID)
	}
	if status.LastExitCode != 137 {
		t.Fatalf("expected last exit code 137, got %d", status.LastExitCode)
	}
	if status.FailureReason != "firecracker process exited with code 137" {
		t.Fatalf("unexpected failure reason: %q", status.FailureReason)
	}
	if status.LastHeartbeat == nil {
		t.Fatalf("expected last heartbeat to be set")
	}
}

func TestStopSandboxCancelsInFlightStartup(t *testing.T) {
	backend, err := NewBackend(Options{
		BinaryPath: "firecracker",
		StateDir:   t.TempDir(),
	})
	if err != nil {
		t.Fatalf("new backend: %v", err)
	}

	rt, err := backend.ensureRuntime("sbx-starting")
	if err != nil {
		t.Fatalf("ensureRuntime: %v", err)
	}

	cancelCalled := make(chan struct{}, 1)
	startupDone := make(chan struct{})
	backend.mu.Lock()
	rt.starting = true
	rt.startupCancel = func() {
		select {
		case cancelCalled <- struct{}{}:
		default:
		}
	}
	rt.startupDone = startupDone
	backend.mu.Unlock()

	statusCh := make(chan contracts.SandboxStatus, 1)
	errCh := make(chan error, 1)
	go func() {
		status, stopErr := backend.StopSandbox(context.Background(), contracts.SandboxStatus{
			SandboxID:     "sbx-starting",
			ObservedState: "starting",
			Health:        "starting",
		})
		if stopErr != nil {
			errCh <- stopErr
			return
		}
		statusCh <- status
	}()

	select {
	case <-cancelCalled:
	case <-time.After(time.Second):
		t.Fatalf("expected stop to cancel in-flight startup")
	}

	select {
	case err := <-errCh:
		t.Fatalf("StopSandbox returned early with error: %v", err)
	case <-statusCh:
		t.Fatalf("StopSandbox returned before startup finished")
	case <-time.After(150 * time.Millisecond):
	}

	backend.mu.Lock()
	rt.starting = false
	rt.startupCancel = nil
	rt.startupDone = nil
	backend.mu.Unlock()
	close(startupDone)

	select {
	case err := <-errCh:
		t.Fatalf("StopSandbox failed: %v", err)
	case status := <-statusCh:
		if status.ObservedState != "stopped" {
			t.Fatalf("expected observed_state stopped, got %q", status.ObservedState)
		}
		if status.Health != "ready" {
			t.Fatalf("expected health ready, got %q", status.Health)
		}
	case <-time.After(time.Second):
		t.Fatalf("timeout waiting for StopSandbox to finish")
	}
}
