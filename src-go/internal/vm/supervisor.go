package vm

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
	"github.com/harmony/nanoclaw/src-go/internal/vm/firecracker"
)

var ErrSandboxNotFound = errors.New("sandbox not found")

type Supervisor struct {
	mu      sync.RWMutex
	backend Backend
	states  map[string]contracts.SandboxStatus
	specs   map[string]contracts.SandboxSpec
}

// NewSupervisor is a compatibility constructor retained for existing callers.
func NewSupervisor(simulated bool, firecrackerBin string) *Supervisor {
	if !simulated {
		backend, err := firecracker.NewBackend(firecracker.Options{
			BinaryPath:  firecrackerBin,
			StateDir:    filepath.Join("/tmp", "nanoclaw-go-vm"),
			NetMode:     firecracker.NetModeNone,
			StopTimeout: 10 * time.Second,
		})
		if err == nil {
			return NewSupervisorWithBackend(backend)
		}
	}
	return NewSupervisorWithBackend(NewSimulatedBackend(firecrackerBin))
}

func NewSupervisorWithBackend(backend Backend) *Supervisor {
	if backend == nil {
		backend = NewSimulatedBackend("")
	}
	return &Supervisor{
		backend: backend,
		states:  map[string]contracts.SandboxStatus{},
		specs:   map[string]contracts.SandboxSpec{},
	}
}

func (s *Supervisor) CreateSandbox(spec contracts.SandboxSpec) contracts.SandboxStatus {
	ctx := context.Background()
	status, err := s.backend.CreateSandbox(ctx, spec)
	if err != nil {
		now := time.Now().UTC()
		status = contracts.SandboxStatus{
			SandboxID:     spec.SandboxID,
			Backend:       s.backend.Name(),
			ObservedState: "stopped",
			Health:        "error",
			FailureReason: err.Error(),
			LastHeartbeat: &now,
		}
	}
	status = s.ensureStatusDefaults(spec, status)

	s.mu.Lock()
	s.states[spec.SandboxID] = status
	s.specs[spec.SandboxID] = spec
	s.mu.Unlock()
	return status
}

func (s *Supervisor) GetStatus(id string) (contracts.SandboxStatus, error) {
	s.mu.RLock()
	st, ok := s.states[id]
	spec := s.specs[id]
	s.mu.RUnlock()
	if !ok {
		return contracts.SandboxStatus{}, ErrSandboxNotFound
	}
	refreshed, err := s.backend.GetStatus(context.Background(), st)
	if err != nil {
		return contracts.SandboxStatus{}, err
	}
	refreshed = s.ensureStatusDefaults(spec, refreshed)
	s.mu.Lock()
	s.states[id] = refreshed
	s.mu.Unlock()
	return refreshed, nil
}

func (s *Supervisor) StartSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error) {
	return s.transition(ctx, id, "running", func(spec contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		return s.backend.StartSandbox(ctx, spec, current)
	})
}

func (s *Supervisor) StopSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error) {
	return s.transition(ctx, id, "stopped", func(_ contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		return s.backend.StopSandbox(ctx, current)
	})
}

func (s *Supervisor) DestroySandbox(ctx context.Context, id string) (contracts.SandboxStatus, error) {
	return s.transition(ctx, id, "destroyed", func(_ contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		return s.backend.DestroySandbox(ctx, current)
	})
}

func (s *Supervisor) SnapshotSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error) {
	return s.transition(ctx, id, "", func(_ contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		return s.backend.SnapshotSandbox(ctx, current)
	})
}

func (s *Supervisor) KillSwitch(ctx context.Context, id string, reason string) (contracts.SandboxStatus, error) {
	return s.transition(ctx, id, "", func(_ contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		return s.backend.KillSwitch(ctx, current, reason)
	})
}

func (s *Supervisor) Summary() map[string]any {
	s.mu.RLock()
	sandboxCount := len(s.states)
	s.mu.RUnlock()

	summary := map[string]any{}
	for k, v := range s.backend.Summary() {
		summary[k] = v
	}
	summary["backend"] = s.backend.Name()
	summary["sandbox_count"] = sandboxCount
	if _, ok := summary["simulated"]; !ok {
		summary["simulated"] = s.backend.Name() == BackendSimulated
	}
	return summary
}

func (s *Supervisor) AssertOneVMSandboxInvariant(id string) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.states[id]; !ok {
		return fmt.Errorf("no VM tracked for sandbox %s", id)
	}
	return nil
}

func (s *Supervisor) transition(
	ctx context.Context,
	id string,
	idempotentState string,
	op func(spec contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error),
) (contracts.SandboxStatus, error) {
	s.mu.RLock()
	current, ok := s.states[id]
	spec := s.specs[id]
	s.mu.RUnlock()
	if !ok {
		return contracts.SandboxStatus{}, ErrSandboxNotFound
	}
	if idempotentState != "" && current.ObservedState == idempotentState {
		refreshed, err := s.backend.GetStatus(ctx, current)
		if err != nil {
			return contracts.SandboxStatus{}, err
		}
		refreshed = s.ensureStatusDefaults(spec, refreshed)
		s.mu.Lock()
		s.states[id] = refreshed
		s.mu.Unlock()
		if refreshed.ObservedState == idempotentState {
			return refreshed, nil
		}
		current = refreshed
	}
	next, err := op(spec, current)
	if err != nil {
		return contracts.SandboxStatus{}, err
	}
	next = s.ensureStatusDefaults(spec, next)

	s.mu.Lock()
	s.states[id] = next
	s.mu.Unlock()
	return next, nil
}

func (s *Supervisor) ensureStatusDefaults(spec contracts.SandboxSpec, status contracts.SandboxStatus) contracts.SandboxStatus {
	if status.SandboxID == "" {
		status.SandboxID = spec.SandboxID
	}
	if status.Backend == "" {
		status.Backend = s.backend.Name()
	}
	if status.ObservedState == "" {
		status.ObservedState = "stopped"
	}
	if status.Health == "" {
		status.Health = "ready"
	}
	if status.LastHeartbeat == nil {
		now := time.Now().UTC()
		status.LastHeartbeat = &now
	}
	return status
}
