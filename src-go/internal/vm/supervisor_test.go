package vm

import (
	"context"
	"testing"

	"github.com/harmony/nanoclaw/src-go/internal/config"
	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

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
