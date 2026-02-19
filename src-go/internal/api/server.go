package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/policy"
	"github.com/harmony/nanoclaw/src-go/internal/reconciler"
	"github.com/harmony/nanoclaw/src-go/internal/session"
	"github.com/harmony/nanoclaw/src-go/internal/store"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

type Server struct {
	store      *store.MemoryStore
	supervisor *vm.Supervisor
	policy     *policy.Engine
	reconciler *reconciler.Reconciler
	sessions   *session.Manager
	bus        *eventBus
}

func NewServer(st *store.MemoryStore, sup *vm.Supervisor, pol *policy.Engine, rec *reconciler.Reconciler, ses *session.Manager) *Server {
	return &Server{
		store:      st,
		supervisor: sup,
		policy:     pol,
		reconciler: rec,
		sessions:   ses,
		bus:        newEventBus(),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/v1/tasks/runs", s.handleTaskRuns)
	mux.HandleFunc("/v1/tasks/", s.handleTaskGet)
	mux.HandleFunc("/v1/sandboxes", s.handleSandboxCreate)
	mux.HandleFunc("/v1/sandboxes/", s.handleSandboxActions)
	mux.HandleFunc("/v1/sessions", s.handleSessionsCreate)
	mux.HandleFunc("/v1/events/stream", s.handleEventsStream)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"time":       time.Now().UTC(),
		"supervisor": s.supervisor.Summary(),
	})
}

func (s *Server) handleTaskRuns(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var spec TaskRunSpec
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if spec.TaskID == "" {
		spec.TaskID = fmt.Sprintf("task-%d-%d", time.Now().Unix(), rand.Intn(1000))
	}
	if spec.SandboxID == "" {
		spec.SandboxID = fmt.Sprintf("sbx-%d-%d", time.Now().Unix(), rand.Intn(1000))
	}

	decision := s.policy.Evaluate(spec)
	if !decision.Allowed {
		result := TaskRunResult{
			TaskID:      spec.TaskID,
			SandboxID:   spec.SandboxID,
			Status:      "denied",
			Error:       decision.Reason,
			Policy:      decision,
			StartedAt:   time.Now().UTC(),
			CompletedAt: time.Now().UTC(),
		}
		_ = s.store.SaveTask(result)
		s.emit("task.denied", map[string]any{"task_id": result.TaskID, "sandbox_id": result.SandboxID, "reason": result.Error})
		writeJSON(w, http.StatusForbidden, result)
		return
	}

	specForSandbox := SandboxSpec{
		SandboxID:    spec.SandboxID,
		DesiredState: "running",
		VMProfile: VMProfile{
			KernelImage: defaultKernelImagePath(),
			RootFSImage: spec.ImageRef,
			VCPU:        max(1, spec.ResourceProfile.CPU),
			MemoryMiB:   max(128, spec.ResourceProfile.Memory),
		},
		NetworkPolicy: NetworkPolicy{DefaultDeny: true, Allow: spec.Capabilities.EgressRules},
		TTLSeconds:    3600,
	}

	status := s.supervisor.CreateSandbox(specForSandbox)
	if err := s.store.UpsertSandbox(specForSandbox, status); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := s.reconciler.ReconcileSandbox(r.Context(), spec.SandboxID); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	_, sandboxStatus, err := s.store.GetSandbox(spec.SandboxID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}

	start := time.Now().UTC()
	result := TaskRunResult{
		TaskID:      spec.TaskID,
		SandboxID:   spec.SandboxID,
		Status:      "accepted",
		Policy:      decision,
		StartedAt:   start,
		CompletedAt: time.Now().UTC(),
	}
	if err := s.store.SaveTask(result); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	s.emit("task.completed", map[string]any{"task_id": result.TaskID, "sandbox_id": result.SandboxID})
	s.emitSandboxStateChanged(sandboxStatus, "task_run")
	writeJSON(w, http.StatusAccepted, s.taskRunAcceptedResponse(result, sandboxStatus, spec))
}

func defaultKernelImagePath() string {
	kernel := strings.TrimSpace(os.Getenv("NANOCLAW_GO_VM_KERNEL_IMAGE"))
	if kernel != "" {
		return kernel
	}
	return "vmlinux"
}

func (s *Server) handleTaskGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/v1/tasks/")
	if id == "" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("missing task id"))
		return
	}
	result, err := s.store.GetTask(id)
	if err != nil {
		if err == store.ErrNotFound {
			writeErr(w, http.StatusNotFound, err)
			return
		}
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleSandboxCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var spec SandboxSpec
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if spec.SandboxID == "" {
		spec.SandboxID = fmt.Sprintf("sbx-%d-%d", time.Now().Unix(), rand.Intn(1000))
	}
	if spec.DesiredState == "" {
		spec.DesiredState = "stopped"
	}
	if spec.NetworkPolicy.Allow == nil {
		spec.NetworkPolicy.DefaultDeny = true
		spec.NetworkPolicy.Allow = []EgressRule{}
	}
	status := s.supervisor.CreateSandbox(spec)
	if err := s.store.UpsertSandbox(spec, status); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if spec.DesiredState == "running" || spec.DesiredState == "started" {
		if err := s.reconciler.ReconcileSandbox(r.Context(), spec.SandboxID); err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		status, _ = s.supervisor.GetStatus(spec.SandboxID)
		_ = s.store.UpdateSandboxStatus(status)
		s.emitSandboxStateChanged(status, "sandbox_create")
	}
	s.emit("sandbox.created", map[string]any{"sandbox_id": spec.SandboxID})
	writeJSON(w, http.StatusAccepted, map[string]any{"spec": spec, "status": status})
}

func (s *Server) handleSandboxActions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/v1/sandboxes/")
	parts := strings.SplitN(p, ":", 2)
	if len(parts) != 2 {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("expected /v1/sandboxes/{id}:{action}"))
		return
	}
	id, action := parts[0], parts[1]
	if id == "" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("missing sandbox id"))
		return
	}
	spec, _, err := s.store.GetSandbox(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	ctx := r.Context()
	switch action {
	case "start":
		spec.DesiredState = "running"
	case "stop":
		spec.DesiredState = "stopped"
	case "destroy":
		spec.DesiredState = "destroyed"
	case "snapshot":
		status, err := s.supervisor.SnapshotSandbox(ctx, id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		_ = s.store.UpdateSandboxStatus(status)
		s.emitSandboxSnapshot(status, "sandbox_action")
		writeJSON(w, http.StatusAccepted, s.snapshotActionResponse(status))
		return
	default:
		writeErr(w, http.StatusBadRequest, fmt.Errorf("unknown action %q", action))
		return
	}
	status, _ := s.supervisor.GetStatus(id)
	if err := s.store.UpsertSandbox(spec, status); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := s.reconciler.ReconcileSandbox(ctx, id); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	status, _ = s.supervisor.GetStatus(id)
	_ = s.store.UpdateSandboxStatus(status)
	s.emitSandboxStateChanged(status, "sandbox_action")
	writeJSON(w, http.StatusAccepted, status)
}

func (s *Server) handleSessionsCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req SessionCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.SandboxID == "" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("sandbox_id is required"))
		return
	}
	sessionInfo, err := s.sessions.Create(req)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	s.emit("session.created", map[string]any{"session_id": sessionInfo.SessionID, "sandbox_id": sessionInfo.SandboxID})
	writeJSON(w, http.StatusAccepted, sessionInfo)
}

func (s *Server) handleEventsStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("streaming unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := s.bus.subscribe()
	defer s.bus.unsubscribe(ch)

	ctx := r.Context()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case evt := <-ch:
			_ = json.NewEncoder(w).Encode(map[string]any{"event": evt.Type, "data": evt})
			fmt.Fprint(w, "\n")
			flusher.Flush()
		case <-ticker.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) emit(eventType string, payload map[string]any) {
	evt := Event{Type: eventType, Timestamp: time.Now().UTC(), Payload: payload}
	if err := s.store.SaveEvent(evt); err != nil {
		log.Printf("event save error: %v", err)
	}
	s.bus.publish(evt)
}

func (s *Server) taskRunAcceptedResponse(result TaskRunResult, status SandboxStatus, spec TaskRunSpec) map[string]any {
	return map[string]any{
		"task_id":        result.TaskID,
		"sandbox_id":     result.SandboxID,
		"status":         result.Status,
		"policy":         result.Policy,
		"started_at":     result.StartedAt,
		"completed_at":   result.CompletedAt,
		"accepted_at":    result.CompletedAt,
		"sandbox_status": status,
		"execution": map[string]any{
			"command":   spec.Command,
			"image_ref": spec.ImageRef,
			"mode":      "accepted",
		},
	}
}

func (s *Server) snapshotActionResponse(status SandboxStatus) map[string]any {
	payload := sandboxStatusToMap(status)
	snapshot := snapshotMetadata(status)
	payload["snapshot"] = snapshot
	if _, ok := payload["snapshot_ref"]; !ok {
		if ref, exists := snapshot["snapshot_ref"]; exists {
			payload["snapshot_ref"] = ref
		}
	}
	if _, ok := payload["snapshot_path"]; !ok {
		if path, exists := snapshot["snapshot_path"]; exists {
			payload["snapshot_path"] = path
		}
	}
	return payload
}

func (s *Server) emitSandboxStateChanged(status SandboxStatus, source string) {
	payload := map[string]any{
		"sandbox_id":     status.SandboxID,
		"state":          status.ObservedState,
		"health":         status.Health,
		"failure_reason": status.FailureReason,
		"snapshot_count": status.SnapshotCount,
		"backend":        s.supervisor.Summary(),
		"runtime":        sandboxRuntimeMetadata(status),
		"source":         source,
	}
	s.emit("sandbox.state_changed", payload)
}

func (s *Server) emitSandboxSnapshot(status SandboxStatus, source string) {
	payload := map[string]any{
		"sandbox_id": status.SandboxID,
		"count":      status.SnapshotCount,
		"snapshot":   snapshotMetadata(status),
		"backend":    s.supervisor.Summary(),
		"runtime":    sandboxRuntimeMetadata(status),
		"source":     source,
	}
	s.emit("sandbox.snapshot", payload)
}

func snapshotMetadata(status SandboxStatus) map[string]any {
	metadata := sandboxRuntimeMetadata(status)
	snapshot := map[string]any{
		"snapshot_count": status.SnapshotCount,
	}
	for key, value := range metadata {
		if strings.HasPrefix(key, "snapshot_") {
			snapshot[key] = value
		}
	}
	return snapshot
}

func sandboxRuntimeMetadata(status SandboxStatus) map[string]any {
	keys := map[string]struct{}{
		"backend":            {},
		"vm_id":              {},
		"pid":                {},
		"api_socket":         {},
		"last_exit_code":     {},
		"snapshot_ref":       {},
		"snapshot_path":      {},
		"runtime_metadata":   {},
		"runtime_info":       {},
		"runtime_error":      {},
		"runtime_started_at": {},
	}
	meta := map[string]any{}
	v := reflect.ValueOf(status)
	t := reflect.TypeOf(status)
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		tag := strings.Split(field.Tag.Get("json"), ",")[0]
		if tag == "" || tag == "-" {
			continue
		}
		if _, ok := keys[tag]; !ok {
			continue
		}
		value := v.Field(i)
		if !value.IsValid() || value.IsZero() {
			continue
		}
		meta[tag] = value.Interface()
	}
	return meta
}

func sandboxStatusToMap(status SandboxStatus) map[string]any {
	raw, err := json.Marshal(status)
	if err != nil {
		return map[string]any{
			"sandbox_id":     status.SandboxID,
			"observed_state": status.ObservedState,
			"health":         status.Health,
			"snapshot_count": status.SnapshotCount,
		}
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return map[string]any{
			"sandbox_id":     status.SandboxID,
			"observed_state": status.ObservedState,
			"health":         status.Health,
			"snapshot_count": status.SnapshotCount,
		}
	}
	return decoded
}

func writeJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]any{"error": err.Error()})
}

func methodNotAllowed(w http.ResponseWriter) {
	writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("method not allowed"))
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

type eventBus struct {
	mu   sync.RWMutex
	subs map[chan Event]struct{}
}

func newEventBus() *eventBus {
	return &eventBus{subs: map[chan Event]struct{}{}}
}

func (b *eventBus) subscribe() chan Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan Event, 64)
	b.subs[ch] = struct{}{}
	return ch
}

func (b *eventBus) unsubscribe(ch chan Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.subs, ch)
	close(ch)
}

func (b *eventBus) publish(evt Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subs {
		select {
		case ch <- evt:
		default:
		}
	}
}

func (s *Server) Shutdown(ctx context.Context) error {
	_ = ctx
	return nil
}
