package vm

import (
	"context"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

const (
	BackendSimulated   = "simulated"
	BackendFirecracker = "firecracker"
)

// Backend encapsulates runtime-specific sandbox operations.
type Backend interface {
	Name() string
	CreateSandbox(ctx context.Context, spec contracts.SandboxSpec) (contracts.SandboxStatus, error)
	StartSandbox(ctx context.Context, spec contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error)
	StopSandbox(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error)
	SnapshotSandbox(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error)
	DestroySandbox(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error)
	KillSwitch(ctx context.Context, current contracts.SandboxStatus, reason string) (contracts.SandboxStatus, error)
	GetStatus(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error)
	Summary() map[string]any
}
