package store

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

func TestSaveEventAppliesRetentionBound(t *testing.T) {
	t.Setenv(eventRetentionEnvKey, "3")
	stateFile := filepath.Join(t.TempDir(), "state.json")
	st, err := NewMemoryStore(stateFile)
	if err != nil {
		t.Fatalf("store init failed: %v", err)
	}

	for i := 0; i < 5; i++ {
		if err := st.SaveEvent(contracts.Event{
			Type:      fmt.Sprintf("evt-%d", i),
			Timestamp: time.Now().UTC(),
			Payload:   map[string]any{"index": i},
		}); err != nil {
			t.Fatalf("save event %d failed: %v", i, err)
		}
	}

	if got := len(st.events); got != 3 {
		t.Fatalf("expected 3 events retained, got %d", got)
	}
	if st.events[0].Type != "evt-2" || st.events[2].Type != "evt-4" {
		t.Fatalf("expected rolling window [evt-2..evt-4], got [%s..%s]", st.events[0].Type, st.events[2].Type)
	}

	reloaded, err := NewMemoryStore(stateFile)
	if err != nil {
		t.Fatalf("reload failed: %v", err)
	}
	if got := len(reloaded.events); got != 3 {
		t.Fatalf("expected 3 persisted events retained on reload, got %d", got)
	}
	if reloaded.events[0].Type != "evt-2" || reloaded.events[2].Type != "evt-4" {
		t.Fatalf("expected persisted rolling window [evt-2..evt-4], got [%s..%s]", reloaded.events[0].Type, reloaded.events[2].Type)
	}
}
