package reconciler

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
	"github.com/harmony/nanoclaw/src-go/internal/store"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

func TestReconcilerHealsStateDrift(t *testing.T) {
	tmpState := filepath.Join(t.TempDir(), "state.json")
	st, err := store.NewMemoryStore(tmpState)
	if err != nil {
		t.Fatalf("store init failed: %v", err)
	}
	sup := vm.NewSupervisor(true, "")
	rec := New(st, sup)

	spec := contracts.SandboxSpec{SandboxID: "sbx-drfit", DesiredState: "running"}
	status := sup.CreateSandbox(spec)
	if err := st.UpsertSandbox(spec, status); err != nil {
		t.Fatalf("upsert failed: %v", err)
	}

	if err := rec.ReconcileSandbox(context.Background(), spec.SandboxID); err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}
	_, current, err := st.GetSandbox(spec.SandboxID)
	if err != nil {
		t.Fatalf("readback failed: %v", err)
	}
	if current.ObservedState != "running" {
		t.Fatalf("expected running state, got %s", current.ObservedState)
	}
}
