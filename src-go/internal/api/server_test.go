package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

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

	var result TaskRunResult
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if result.SandboxID == "" || result.TaskID == "" {
		t.Fatalf("expected generated ids")
	}

	req2 := httptest.NewRequest(http.MethodPost, "/v1/sandboxes/"+result.SandboxID+":stop", nil)
	resp2 := httptest.NewRecorder()
	h.ServeHTTP(resp2, req2)
	if resp2.Code != http.StatusAccepted {
		t.Fatalf("expected 202 on stop, got %d", resp2.Code)
	}
}
