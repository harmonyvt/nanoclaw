package vm

import (
	"context"
	"testing"

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
	if _, err := sup.DestroySandbox(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("destroy failed: %v", err)
	}
}
