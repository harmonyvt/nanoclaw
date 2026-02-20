package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
	"github.com/harmony/nanoclaw/src-go/internal/store"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

func TestReconcilerHealsStateDrift(t *testing.T) {
	tmpState := filepath.Join(t.TempDir(), "state.json")
	st, err := store.NewMemoryStore(tmpState)
	if err != nil {
		t.Fatalf("store init failed: %v", err)
	}
	sup := vm.NewSupervisor(true, "")
	rec := New(st, sup)

	spec := contracts.SandboxSpec{SandboxID: "sbx-drfit", DesiredState: "running"}
	status := sup.CreateSandbox(spec)
	if err := st.UpsertSandbox(spec, status); err != nil {
		t.Fatalf("upsert failed: %v", err)
	}

	if err := rec.ReconcileSandbox(context.Background(), spec.SandboxID); err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}
	_, current, err := st.GetSandbox(spec.SandboxID)
	if err != nil {
		t.Fatalf("readback failed: %v", err)
	}
	if current.ObservedState != "running" {
		t.Fatalf("expected running state, got %s", current.ObservedState)
	}
	if current.FailureReason != "" {
		t.Fatalf("expected empty failure reason, got %s", current.FailureReason)
	}
}

func TestReconcilerRejectsIllegalTransition(t *testing.T) {
	tmpState := filepath.Join(t.TempDir(), "state.json")
	st, err := store.NewMemoryStore(tmpState)
	if err != nil {
		t.Fatalf("store init failed: %v", err)
	}
	sup := vm.NewSupervisor(true, "")
	rec := New(st, sup)

	spec := contracts.SandboxSpec{SandboxID: "sbx-illegal", DesiredState: "running"}
	_ = sup.CreateSandbox(spec)
	destroyed, err := sup.DestroySandbox(context.Background(), spec.SandboxID)
	if err != nil {
		t.Fatalf("destroy failed: %v", err)
	}
	if err := st.UpsertSandbox(spec, destroyed); err != nil {
		t.Fatalf("upsert failed: %v", err)
	}

	if err := rec.ReconcileSandbox(context.Background(), spec.SandboxID); err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	_, current, err := st.GetSandbox(spec.SandboxID)
	if err != nil {
		t.Fatalf("readback failed: %v", err)
	}
	if current.Health != "error" {
		t.Fatalf("expected error health, got %s", current.Health)
	}
	if code := failureCode(t, current.FailureReason); code != failureCodeIllegalTransition {
		t.Fatalf("expected failure code %s, got %s (%s)", failureCodeIllegalTransition, code, current.FailureReason)
	}
}

func TestReconcilerRetriesTransientRuntimeErrors(t *testing.T) {
	tmpState := filepath.Join(t.TempDir(), "state.json")
	st, err := store.NewMemoryStore(tmpState)
	if err != nil {
		t.Fatalf("store init failed: %v", err)
	}
	rt := &stubRuntime{
		startResults: []stubTransitionResult{
			{err: errors.New("temporarily unavailable")},
			{status: contracts.SandboxStatus{SandboxID: "sbx-retry", ObservedState: "running", Health: "healthy"}},
		},
	}
	rec := &Reconciler{
		store:              st,
		supervisor:         rt,
		maxRuntimeAttempts: 3,
		baseBackoff:        time.Millisecond,
		maxBackoff:         2 * time.Millisecond,
	}

	spec := contracts.SandboxSpec{SandboxID: "sbx-retry", DesiredState: "running"}
	initial := contracts.SandboxStatus{SandboxID: spec.SandboxID, ObservedState: "stopped", Health: "ready"}
	if err := st.UpsertSandbox(spec, initial); err != nil {
		t.Fatalf("upsert failed: %v", err)
	}

	if err := rec.ReconcileSandbox(context.Background(), spec.SandboxID); err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}
	if rt.startCalls != 2 {
		t.Fatalf("expected 2 start attempts, got %d", rt.startCalls)
	}

	_, current, err := st.GetSandbox(spec.SandboxID)
	if err != nil {
		t.Fatalf("readback failed: %v", err)
	}
	if current.ObservedState != "running" {
		t.Fatalf("expected running state, got %s", current.ObservedState)
	}
	if current.FailureReason != "" {
		t.Fatalf("expected empty failure reason, got %s", current.FailureReason)
	}
}

func TestReconcilerPersistsTransientFailureAfterRetryExhaustion(t *testing.T) {
	tmpState := filepath.Join(t.TempDir(), "state.json")
	st, err := store.NewMemoryStore(tmpState)
	if err != nil {
		t.Fatalf("store init failed: %v", err)
	}
	rt := &stubRuntime{
		startResults: []stubTransitionResult{
			{err: errors.New("temporary timeout")},
			{err: errors.New("temporary timeout")},
			{err: errors.New("temporary timeout")},
		},
	}
	rec := &Reconciler{
		store:              st,
		supervisor:         rt,
		maxRuntimeAttempts: 3,
		baseBackoff:        time.Millisecond,
		maxBackoff:         2 * time.Millisecond,
	}

	spec := contracts.SandboxSpec{SandboxID: "sbx-retry-exhausted", DesiredState: "running"}
	initial := contracts.SandboxStatus{SandboxID: spec.SandboxID, ObservedState: "stopped", Health: "ready"}
	if err := st.UpsertSandbox(spec, initial); err != nil {
		t.Fatalf("upsert failed: %v", err)
	}

	if err := rec.ReconcileSandbox(context.Background(), spec.SandboxID); err == nil {
		t.Fatalf("expected reconcile to return runtime error after retry exhaustion")
	}
	if rt.startCalls != 3 {
		t.Fatalf("expected 3 start attempts, got %d", rt.startCalls)
	}

	_, current, err := st.GetSandbox(spec.SandboxID)
	if err != nil {
		t.Fatalf("readback failed: %v", err)
	}
	if current.Health != "error" {
		t.Fatalf("expected error health, got %s", current.Health)
	}
	if code := failureCode(t, current.FailureReason); code != failureCodeRuntimeTransient {
		t.Fatalf("expected failure code %s, got %s (%s)", failureCodeRuntimeTransient, code, current.FailureReason)
	}
}

type stubRuntime struct {
	startCalls   int
	startResults []stubTransitionResult
	stopCalls    int
}

type stubTransitionResult struct {
	status contracts.SandboxStatus
	err    error
}

func (s *stubRuntime) StartSandbox(_ context.Context, id string) (contracts.SandboxStatus, error) {
	result := s.transitionResult(s.startCalls, id, "running", "healthy")
	s.startCalls++
	return result.status, result.err
}

func (s *stubRuntime) StopSandbox(_ context.Context, id string) (contracts.SandboxStatus, error) {
	s.stopCalls++
	return contracts.SandboxStatus{
		SandboxID:     id,
		ObservedState: "stopped",
		Health:        "ready",
	}, nil
}

func (s *stubRuntime) DestroySandbox(_ context.Context, id string) (contracts.SandboxStatus, error) {
	return contracts.SandboxStatus{
		SandboxID:     id,
		ObservedState: "destroyed",
		Health:        "terminated",
	}, nil
}

func (s *stubRuntime) transitionResult(call int, id string, observedState string, health string) stubTransitionResult {
	if call < len(s.startResults) {
		result := s.startResults[call]
		if result.status.SandboxID == "" {
			result.status.SandboxID = id
		}
		if result.status.ObservedState == "" {
			result.status.ObservedState = observedState
		}
		if result.status.Health == "" {
			result.status.Health = health
		}
		return result
	}
	return stubTransitionResult{status: contracts.SandboxStatus{SandboxID: id, ObservedState: observedState, Health: health}}
}

func failureCode(t *testing.T, reason string) string {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal([]byte(reason), &parsed); err != nil {
		t.Fatalf("failure reason is not machine parseable JSON: %v (%s)", err, reason)
	}
	code, ok := parsed["code"].(string)
	if !ok || code == "" {
		t.Fatalf("failure reason missing code: %s", reason)
	}
	return code
}

func TestReconcilerAllowsStopWhileStarting(t *testing.T) {
	tmpState := filepath.Join(t.TempDir(), "state.json")
	st, err := store.NewMemoryStore(tmpState)
	if err != nil {
		t.Fatalf("store init failed: %v", err)
	}
	rt := &stubRuntime{}
	rec := &Reconciler{
		store:              st,
		supervisor:         rt,
		maxRuntimeAttempts: 1,
		baseBackoff:        time.Millisecond,
		maxBackoff:         time.Millisecond,
	}

	spec := contracts.SandboxSpec{SandboxID: "sbx-starting-stop", DesiredState: "stopped"}
	initial := contracts.SandboxStatus{
		SandboxID:     spec.SandboxID,
		ObservedState: "starting",
		Health:        "starting",
	}
	if err := st.UpsertSandbox(spec, initial); err != nil {
		t.Fatalf("upsert failed: %v", err)
	}

	if err := rec.ReconcileSandbox(context.Background(), spec.SandboxID); err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	if rt.stopCalls != 1 {
		t.Fatalf("expected stop to be invoked once, got %d", rt.stopCalls)
	}
	_, current, err := st.GetSandbox(spec.SandboxID)
	if err != nil {
		t.Fatalf("readback failed: %v", err)
	}
	if current.ObservedState != "stopped" {
		t.Fatalf("expected stopped state, got %s", current.ObservedState)
	}
	if current.Health != "ready" {
		t.Fatalf("expected ready health, got %s", current.Health)
	}
	if current.FailureReason != "" {
		t.Fatalf("expected empty failure reason, got %s", current.FailureReason)
	}
}
