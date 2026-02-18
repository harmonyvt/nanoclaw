package reconciler

import (
	"context"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/store"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

type Reconciler struct {
	store      *store.MemoryStore
	supervisor *vm.Supervisor
}

func New(s *store.MemoryStore, sup *vm.Supervisor) *Reconciler {
	return &Reconciler{store: s, supervisor: sup}
}

func (r *Reconciler) ReconcileSandbox(ctx context.Context, sandboxID string) error {
	spec, status, err := r.store.GetSandbox(sandboxID)
	if err != nil {
		return err
	}

	switch spec.DesiredState {
	case "running", "started":
		status, err = r.supervisor.StartSandbox(ctx, sandboxID)
	case "stopped":
		status, err = r.supervisor.StopSandbox(ctx, sandboxID)
	case "destroyed":
		status, err = r.supervisor.DestroySandbox(ctx, sandboxID)
	default:
		status.Health = "error"
		status.FailureReason = "unknown desired_state"
	}
	if err != nil {
		status.Health = "error"
		status.FailureReason = err.Error()
	}
	now := time.Now().UTC()
	status.LastHeartbeat = &now
	return r.store.UpdateSandboxStatus(status)
}

func (r *Reconciler) ReconcileAll(ctx context.Context) error {
	for _, status := range r.store.ListSandboxes() {
		if err := r.ReconcileSandbox(ctx, status.SandboxID); err != nil {
			return err
		}
	}
	return nil
}
