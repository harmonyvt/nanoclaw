package firecracker

import (
	"context"
	"path/filepath"
	"testing"

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
