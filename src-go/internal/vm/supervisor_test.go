package vm

import (
	"context"
	"testing"

	"github.com/harmony/nanoclaw/src-go/internal/config"
	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

type transitionTestBackend struct {
	createStatus contracts.SandboxStatus

	getStatusCalls int
	stopCalls      int
	destroyCalls   int

	getStatusFn func(context.Context, contracts.SandboxStatus) (contracts.SandboxStatus, error)
	stopFn      func(context.Context, contracts.SandboxStatus) (contracts.SandboxStatus, error)
	destroyFn   func(context.Context, contracts.SandboxStatus) (contracts.SandboxStatus, error)
}

func (b *transitionTestBackend) Name() string {
	return "transition-test"
}

func (b *transitionTestBackend) CreateSandbox(_ context.Context, spec contracts.SandboxSpec) (contracts.SandboxStatus, error) {
	status := b.createStatus
	if status.SandboxID == "" {
		status.SandboxID = spec.SandboxID
	}
	if status.ObservedState == "" {
		status.ObservedState = "stopped"
	}
	if status.Health == "" {
		status.Health = "ready"
	}
	return status, nil
}

func (b *transitionTestBackend) StartSandbox(_ context.Context, _ contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	current.ObservedState = "running"
	current.Health = "healthy"
	return current, nil
}

func (b *transitionTestBackend) StopSandbox(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	b.stopCalls++
	if b.stopFn != nil {
		return b.stopFn(ctx, current)
	}
	current.ObservedState = "stopped"
	current.Health = "ready"
	return current, nil
}

func (b *transitionTestBackend) SnapshotSandbox(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	current.SnapshotCount++
	return current, nil
}

func (b *transitionTestBackend) DestroySandbox(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	b.destroyCalls++
	if b.destroyFn != nil {
		return b.destroyFn(ctx, current)
	}
	current.ObservedState = "destroyed"
	current.Health = "terminated"
	return current, nil
}

func (b *transitionTestBackend) KillSwitch(_ context.Context, current contracts.SandboxStatus, _ string) (contracts.SandboxStatus, error) {
	current.ObservedState = "terminated"
	current.Health = "quarantined"
	return current, nil
}

func (b *transitionTestBackend) GetStatus(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	b.getStatusCalls++
	if b.getStatusFn != nil {
		return b.getStatusFn(ctx, current)
	}
	return current, nil
}

func (b *transitionTestBackend) Summary() map[string]any {
	return map[string]any{"backend": b.Name()}
}

func TestLifecycleIdempotency(t *testing.T) {
	sup := NewSupervisor(true, "")
	spec := contracts.SandboxSpec{SandboxID: "sbx-1", DesiredState: "stopped"}
	_ = sup.CreateSandbox(spec)

	if _, err := sup.StartSandbox(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	if _, err := sup.StartSandbox(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("idempotent start failed: %v", err)
	}
	if _, err := sup.StopSandbox(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("stop failed: %v", err)
	}
	if _, err := sup.StopSandbox(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("idempotent stop failed: %v", err)
	}
	if _, err := sup.SnapshotSandbox(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("snapshot failed: %v", err)
	}
	st, _ := sup.GetStatus("sbx-1")
	if st.SnapshotCount != 1 {
		t.Fatalf("expected snapshot count 1, got %d", st.SnapshotCount)
	}
	if st.Backend != BackendSimulated {
		t.Fatalf("expected backend %q, got %q", BackendSimulated, st.Backend)
	}
	if _, err := sup.DestroySandbox(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("destroy failed: %v", err)
	}
}

func TestIdempotentStopRefreshesBackendStatus(t *testing.T) {
	backend := &transitionTestBackend{
		createStatus: contracts.SandboxStatus{
			ObservedState: "stopped",
			Health:        "ready",
		},
	}
	backend.getStatusFn = func(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		current.ObservedState = "running"
		current.Health = "healthy"
		return current, nil
	}
	backend.stopFn = func(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		if current.ObservedState != "running" {
			t.Fatalf("expected stop to run against refreshed running state, got %q", current.ObservedState)
		}
		current.ObservedState = "stopped"
		current.Health = "ready"
		return current, nil
	}

	sup := NewSupervisorWithBackend(backend)
	spec := contracts.SandboxSpec{SandboxID: "sbx-stop-refresh", DesiredState: "stopped"}
	_ = sup.CreateSandbox(spec)

	status, err := sup.StopSandbox(context.Background(), spec.SandboxID)
	if err != nil {
		t.Fatalf("StopSandbox failed: %v", err)
	}
	if backend.getStatusCalls != 1 {
		t.Fatalf("expected one backend status refresh, got %d", backend.getStatusCalls)
	}
	if backend.stopCalls != 1 {
		t.Fatalf("expected one backend stop call, got %d", backend.stopCalls)
	}
	if status.ObservedState != "stopped" {
		t.Fatalf("expected stopped state, got %q", status.ObservedState)
	}
}

func TestIdempotentDestroyRefreshesBackendStatus(t *testing.T) {
	backend := &transitionTestBackend{
		createStatus: contracts.SandboxStatus{
			ObservedState: "destroyed",
			Health:        "terminated",
		},
	}
	backend.getStatusFn = func(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		current.ObservedState = "running"
		current.Health = "healthy"
		return current, nil
	}
	backend.destroyFn = func(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		if current.ObservedState != "running" {
			t.Fatalf("expected destroy to run against refreshed running state, got %q", current.ObservedState)
		}
		current.ObservedState = "destroyed"
		current.Health = "terminated"
		return current, nil
	}

	sup := NewSupervisorWithBackend(backend)
	spec := contracts.SandboxSpec{SandboxID: "sbx-destroy-refresh", DesiredState: "stopped"}
	_ = sup.CreateSandbox(spec)

	status, err := sup.DestroySandbox(context.Background(), spec.SandboxID)
	if err != nil {
		t.Fatalf("DestroySandbox failed: %v", err)
	}
	if backend.getStatusCalls != 1 {
		t.Fatalf("expected one backend status refresh, got %d", backend.getStatusCalls)
	}
	if backend.destroyCalls != 1 {
		t.Fatalf("expected one backend destroy call, got %d", backend.destroyCalls)
	}
	if status.ObservedState != "destroyed" {
		t.Fatalf("expected destroyed state, got %q", status.ObservedState)
	}
}

func TestNewBackendFromConfigDefaultsToSimulated(t *testing.T) {
	t.Setenv("NANOCLAW_GO_VM_BACKEND", "")
	t.Setenv("NANOCLAW_GO_FIRECRACKER_BIN", "")
	t.Setenv("NANOCLAW_GO_SIMULATED_VM", "")

	cfg := config.Load()
	if cfg.VMBackend != BackendSimulated {
		t.Fatalf("expected default backend %q, got %q", BackendSimulated, cfg.VMBackend)
	}

	backend, err := NewBackendFromConfig(cfg)
	if err != nil {
		t.Fatalf("expected simulated backend without error, got %v", err)
	}
	if backend.Name() != BackendSimulated {
		t.Fatalf("expected backend %q, got %q", BackendSimulated, backend.Name())
	}
}

func TestLegacySimulatedFlagStillSelectsFirecracker(t *testing.T) {
	t.Setenv("NANOCLAW_GO_VM_BACKEND", "")
	t.Setenv("NANOCLAW_GO_FIRECRACKER_BIN", "")
	t.Setenv("NANOCLAW_GO_SIMULATED_VM", "false")

	cfg := config.Load()
	if cfg.VMBackend != BackendFirecracker {
		t.Fatalf("expected legacy compatibility backend %q, got %q", BackendFirecracker, cfg.VMBackend)
	}

	if _, err := NewBackendFromConfig(cfg); err == nil {
		t.Fatalf("expected firecracker backend init error when binary is missing")
	}
}

func TestExplicitBackendOverridesLegacyInputs(t *testing.T) {
	t.Setenv("NANOCLAW_GO_VM_BACKEND", BackendSimulated)
	t.Setenv("NANOCLAW_GO_FIRECRACKER_BIN", "/tmp/ignored-firecracker")
	t.Setenv("NANOCLAW_GO_SIMULATED_VM", "false")

	cfg := config.Load()
	if cfg.VMBackend != BackendSimulated {
		t.Fatalf("expected explicit backend %q, got %q", BackendSimulated, cfg.VMBackend)
	}

	backend, err := NewBackendFromConfig(cfg)
	if err != nil {
		t.Fatalf("expected simulated backend without error, got %v", err)
	}
	if backend.Name() != BackendSimulated {
		t.Fatalf("expected backend %q, got %q", BackendSimulated, backend.Name())
	}
}

func TestFirecrackerBackendSelectedWithConfig(t *testing.T) {
	cfg := config.Config{
		VMBackend:      BackendFirecracker,
		FirecrackerBin: "/tmp/mock-firecracker",
		VMStateDir:     t.TempDir(),
		VMNetMode:      "none",
	}

	backend, err := NewBackendFromConfig(cfg)
	if err != nil {
		t.Fatalf("expected firecracker backend without constructor error, got %v", err)
	}
	if backend.Name() != BackendFirecracker {
		t.Fatalf("expected backend %q, got %q", BackendFirecracker, backend.Name())
	}
}
