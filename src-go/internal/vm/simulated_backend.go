package vm

import (
	"context"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

// SimulatedBackend keeps in-memory behavior parity with the prior supervisor-only implementation.
type SimulatedBackend struct {
	firecrackerBin string
}

func NewSimulatedBackend(firecrackerBin string) *SimulatedBackend {
	return &SimulatedBackend{firecrackerBin: firecrackerBin}
}

func (b *SimulatedBackend) Name() string {
	return BackendSimulated
}

func (b *SimulatedBackend) CreateSandbox(_ context.Context, spec contracts.SandboxSpec) (contracts.SandboxStatus, error) {
	now := time.Now().UTC()
	return contracts.SandboxStatus{
		SandboxID:     spec.SandboxID,
		Backend:       b.Name(),
		VMID:          "sim-" + spec.SandboxID,
		ObservedState: "stopped",
		Health:        "ready",
		LastHeartbeat: &now,
	}, nil
}

func (b *SimulatedBackend) StartSandbox(_ context.Context, _ contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	now := time.Now().UTC()
	current.Backend = b.Name()
	current.ObservedState = "running"
	current.Health = "healthy"
	current.StartedAt = &now
	current.LastHeartbeat = &now
	if current.VMID == "" {
		current.VMID = "sim-" + current.SandboxID
	}
	return current, nil
}

func (b *SimulatedBackend) StopSandbox(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	now := time.Now().UTC()
	current.Backend = b.Name()
	current.ObservedState = "stopped"
	current.Health = "ready"
	current.LastHeartbeat = &now
	if current.VMID == "" {
		current.VMID = "sim-" + current.SandboxID
	}
	return current, nil
}

func (b *SimulatedBackend) SnapshotSandbox(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	now := time.Now().UTC()
	current.Backend = b.Name()
	current.SnapshotCount++
	current.LastHeartbeat = &now
	if current.VMID == "" {
		current.VMID = "sim-" + current.SandboxID
	}
	if current.SnapshotRef == "" {
		current.SnapshotRef = "sim-snapshot-" + current.SandboxID
	}
	return current, nil
}

func (b *SimulatedBackend) DestroySandbox(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	now := time.Now().UTC()
	current.Backend = b.Name()
	current.ObservedState = "destroyed"
	current.Health = "terminated"
	current.LastHeartbeat = &now
	if current.VMID == "" {
		current.VMID = "sim-" + current.SandboxID
	}
	return current, nil
}

func (b *SimulatedBackend) KillSwitch(_ context.Context, current contracts.SandboxStatus, reason string) (contracts.SandboxStatus, error) {
	now := time.Now().UTC()
	current.Backend = b.Name()
	current.ObservedState = "terminated"
	current.Health = "quarantined"
	current.KillSwitchNote = reason
	current.LastHeartbeat = &now
	if current.VMID == "" {
		current.VMID = "sim-" + current.SandboxID
	}
	return current, nil
}

func (b *SimulatedBackend) GetStatus(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	current.Backend = b.Name()
	if current.VMID == "" {
		current.VMID = "sim-" + current.SandboxID
	}
	return current, nil
}

func (b *SimulatedBackend) Summary() map[string]any {
	return map[string]any{
		"backend":         b.Name(),
		"simulated":       true,
		"firecracker_bin": b.firecrackerBin,
	}
}
