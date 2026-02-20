package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/policy"
	"github.com/harmony/nanoclaw/src-go/internal/reconciler"
	"github.com/harmony/nanoclaw/src-go/internal/session"
	"github.com/harmony/nanoclaw/src-go/internal/store"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	st, err := store.NewMemoryStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("store init failed: %v", err)
	}
	sup := vm.NewSupervisor(true, "")
	pol := policy.NewEngine("test-key")
	rec := reconciler.New(st, sup)
	ses := session.NewManager(st)
	return NewServer(st, sup, pol, rec, ses)
}

func TestTaskRunAndSandboxActions(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	events := srv.bus.subscribe()
	defer srv.bus.unsubscribe(events)

	spec := TaskRunSpec{
		RiskClass: "high",
		ImageRef:  "rootfs.img",
		Capabilities: CapabilityPolicy{
			EgressRules: []EgressRule{{Host: "api.example.com", Port: 443}},
		},
		ResourceProfile: ResourceProfile{CPU: 2, Memory: 512, Pids: 128},
		Command:         "echo hi",
	}
	raw, _ := json.Marshal(spec)
	req := httptest.NewRequest(http.MethodPost, "/v1/tasks/runs", bytes.NewReader(raw))
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", resp.Code, resp.Body.String())
	}

	var result map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	taskID, _ := result["task_id"].(string)
	sandboxID, _ := result["sandbox_id"].(string)
	if taskID == "" || sandboxID == "" {
		t.Fatalf("expected generated ids")
	}
	if status, _ := result["status"].(string); status != "accepted" {
		t.Fatalf("expected accepted status, got %q", status)
	}
	if _, hasOutput := result["output"]; hasOutput {
		t.Fatalf("expected no simulated output in task run response")
	}
	if _, ok := result["sandbox_status"].(map[string]any); !ok {
		t.Fatalf("expected sandbox_status metadata")
	}
	execution, ok := result["execution"].(map[string]any)
	if !ok {
		t.Fatalf("expected execution metadata")
	}
	if mode, _ := execution["mode"].(string); mode != "accepted" {
		t.Fatalf("expected execution mode accepted, got %q", mode)
	}
	acceptedEvt := waitForEventType(t, events, "task.accepted")
	if acceptedEvt.Payload["task_id"] != taskID {
		t.Fatalf("expected task.accepted payload task_id %q, got %v", taskID, acceptedEvt.Payload["task_id"])
	}
	if acceptedEvt.Payload["sandbox_id"] != sandboxID {
		t.Fatalf("expected task.accepted payload sandbox_id %q, got %v", sandboxID, acceptedEvt.Payload["sandbox_id"])
	}
	stateEvt := waitForEventType(t, events, "sandbox.state_changed")
	if _, ok := stateEvt.Payload["backend"]; !ok {
		t.Fatalf("expected backend metadata in sandbox state event payload")
	}
	if _, ok := stateEvt.Payload["runtime"]; !ok {
		t.Fatalf("expected runtime metadata in sandbox state event payload")
	}

	req2 := httptest.NewRequest(http.MethodPost, "/v1/sandboxes/"+sandboxID+":stop", nil)
	resp2 := httptest.NewRecorder()
	h.ServeHTTP(resp2, req2)
	if resp2.Code != http.StatusAccepted {
		t.Fatalf("expected 202 on stop, got %d", resp2.Code)
	}

	req3 := httptest.NewRequest(http.MethodPost, "/v1/sandboxes/"+sandboxID+":snapshot", nil)
	resp3 := httptest.NewRecorder()
	h.ServeHTTP(resp3, req3)
	if resp3.Code != http.StatusAccepted {
		t.Fatalf("expected 202 on snapshot, got %d", resp3.Code)
	}
	var snapshotResp map[string]any
	if err := json.Unmarshal(resp3.Body.Bytes(), &snapshotResp); err != nil {
		t.Fatalf("snapshot decode failed: %v", err)
	}
	snapshotMeta, ok := snapshotResp["snapshot"].(map[string]any)
	if !ok {
		t.Fatalf("expected snapshot metadata in response")
	}
	count, _ := snapshotMeta["snapshot_count"].(float64)
	if count < 1 {
		t.Fatalf("expected snapshot_count >= 1, got %v", snapshotMeta["snapshot_count"])
	}

	snapshotEvt := waitForEventType(t, events, "sandbox.snapshot")
	if _, ok := snapshotEvt.Payload["backend"]; !ok {
		t.Fatalf("expected backend metadata in snapshot event payload")
	}
	if _, ok := snapshotEvt.Payload["runtime"]; !ok {
		t.Fatalf("expected runtime metadata in snapshot event payload")
	}
	if _, ok := snapshotEvt.Payload["snapshot"]; !ok {
		t.Fatalf("expected snapshot metadata in snapshot event payload")
	}
}

func waitForEventType(t *testing.T, ch chan Event, eventType string) Event {
	t.Helper()
	timeout := time.After(2 * time.Second)
	for {
		select {
		case evt := <-ch:
			if evt.Type == eventType {
				return evt
			}
		case <-timeout:
			t.Fatalf("timed out waiting for event %s", eventType)
		}
	}
}
