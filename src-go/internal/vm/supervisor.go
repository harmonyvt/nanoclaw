package vm

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

var ErrSandboxNotFound = errors.New("sandbox not found")

type Supervisor struct {
	mu          sync.RWMutex
	simulated   bool
	firecracker string
	states      map[string]contracts.SandboxStatus
}

func NewSupervisor(simulated bool, firecracker string) *Supervisor {
	return &Supervisor{
		simulated:   simulated,
		firecracker: firecracker,
		states:      map[string]contracts.SandboxStatus{},
	}
}

func (s *Supervisor) CreateSandbox(spec contracts.SandboxSpec) contracts.SandboxStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	status := contracts.SandboxStatus{
		SandboxID:     spec.SandboxID,
		ObservedState: "stopped",
		Health:        "ready",
		LastHeartbeat: &now,
	}
	s.states[spec.SandboxID] = status
	return status
}

func (s *Supervisor) GetStatus(id string) (contracts.SandboxStatus, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st, ok := s.states[id]
	if !ok {
		return contracts.SandboxStatus{}, ErrSandboxNotFound
	}
	return st, nil
}

func (s *Supervisor) StartSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[id]
	if !ok {
		return contracts.SandboxStatus{}, ErrSandboxNotFound
	}
	if st.ObservedState == "running" {
		return st, nil
	}
	now := time.Now().UTC()
	st.ObservedState = "running"
	st.Health = "healthy"
	st.StartedAt = &now
	st.LastHeartbeat = &now
	s.states[id] = st
	return st, nil
}

func (s *Supervisor) StopSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[id]
	if !ok {
		return contracts.SandboxStatus{}, ErrSandboxNotFound
	}
	if st.ObservedState == "stopped" {
		return st, nil
	}
	now := time.Now().UTC()
	st.ObservedState = "stopped"
	st.Health = "ready"
	st.LastHeartbeat = &now
	s.states[id] = st
	return st, nil
}

func (s *Supervisor) DestroySandbox(ctx context.Context, id string) (contracts.SandboxStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[id]
	if !ok {
		return contracts.SandboxStatus{}, ErrSandboxNotFound
	}
	st.ObservedState = "destroyed"
	st.Health = "terminated"
	now := time.Now().UTC()
	st.LastHeartbeat = &now
	s.states[id] = st
	return st, nil
}

func (s *Supervisor) SnapshotSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[id]
	if !ok {
		return contracts.SandboxStatus{}, ErrSandboxNotFound
	}
	st.SnapshotCount++
	now := time.Now().UTC()
	st.LastHeartbeat = &now
	s.states[id] = st
	return st, nil
}

func (s *Supervisor) KillSwitch(ctx context.Context, id string, reason string) (contracts.SandboxStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[id]
	if !ok {
		return contracts.SandboxStatus{}, ErrSandboxNotFound
	}
	st.ObservedState = "terminated"
	st.Health = "quarantined"
	st.KillSwitchNote = reason
	now := time.Now().UTC()
	st.LastHeartbeat = &now
	s.states[id] = st
	return st, nil
}

func (s *Supervisor) Summary() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return map[string]any{
		"simulated":       s.simulated,
		"firecracker_bin": s.firecracker,
		"sandbox_count":   len(s.states),
	}
}

func (s *Supervisor) AssertOneVMSandboxInvariant(id string) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.states[id]; !ok {
		return fmt.Errorf("no VM tracked for sandbox %s", id)
	}
	return nil
}
