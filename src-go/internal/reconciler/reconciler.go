package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
	"github.com/harmony/nanoclaw/src-go/internal/store"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

const (
	desiredStateRunning   = "running"
	desiredStateStarted   = "started"
	desiredStateStopped   = "stopped"
	desiredStateDestroyed = "destroyed"

	failureCodeUnknownDesiredState = "E_DESIRED_STATE_UNKNOWN"
	failureCodeIllegalTransition   = "E_ILLEGAL_TRANSITION"
	failureCodeRuntimeTransient    = "E_RUNTIME_TRANSIENT"
	failureCodeRuntimeTerminal     = "E_RUNTIME_TERMINAL"
)

const (
	defaultMaxRuntimeAttempts = 4
	defaultBaseBackoff        = 100 * time.Millisecond
	defaultMaxBackoff         = 2 * time.Second
)

type sandboxRuntime interface {
	StartSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error)
	StopSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error)
	DestroySandbox(ctx context.Context, id string) (contracts.SandboxStatus, error)
}

type Reconciler struct {
	store      *store.MemoryStore
	supervisor sandboxRuntime

	maxRuntimeAttempts int
	baseBackoff        time.Duration
	maxBackoff         time.Duration
}

func New(s *store.MemoryStore, sup *vm.Supervisor) *Reconciler {
	return &Reconciler{
		store:              s,
		supervisor:         sup,
		maxRuntimeAttempts: defaultMaxRuntimeAttempts,
		baseBackoff:        defaultBaseBackoff,
		maxBackoff:         defaultMaxBackoff,
	}
}

func (r *Reconciler) ReconcileSandbox(ctx context.Context, sandboxID string) error {
	spec, status, err := r.store.GetSandbox(sandboxID)
	if err != nil {
		return err
	}

	desiredState := normalizeDesiredState(spec.DesiredState)
	if desiredState == "" {
		status.Health = "error"
		status.FailureReason = encodeFailureReason(
			failureCodeUnknownDesiredState,
			fmt.Sprintf("unsupported desired_state %q", spec.DesiredState),
			false,
			0,
		)
		return r.persistStatus(status)
	}

	if !isLegalTransition(status.ObservedState, desiredState) {
		status.Health = "error"
		status.FailureReason = encodeFailureReason(
			failureCodeIllegalTransition,
			fmt.Sprintf("illegal transition from %q to %q", status.ObservedState, desiredState),
			false,
			0,
		)
		return r.persistStatus(status)
	}

	nextStatus, runErr, attempts, retryable := r.executeTransition(ctx, sandboxID, desiredState)
	if runErr != nil {
		status.Health = "error"
		failureCode := failureCodeRuntimeTerminal
		if retryable {
			failureCode = failureCodeRuntimeTransient
		}
		status.FailureReason = encodeFailureReason(
			failureCode,
			runErr.Error(),
			retryable,
			attempts,
		)
		return r.persistStatus(status)
	}

	nextStatus.FailureReason = ""
	return r.persistStatus(nextStatus)
}

func (r *Reconciler) ReconcileAll(ctx context.Context) error {
	for _, status := range r.store.ListSandboxes() {
		if err := r.ReconcileSandbox(ctx, status.SandboxID); err != nil {
			return err
		}
	}
	return nil
}

func (r *Reconciler) persistStatus(status contracts.SandboxStatus) error {
	now := time.Now().UTC()
	status.LastHeartbeat = &now
	return r.store.UpdateSandboxStatus(status)
}

func (r *Reconciler) executeTransition(ctx context.Context, sandboxID string, desiredState string) (contracts.SandboxStatus, error, int, bool) {
	transitionFunc := r.transitionFunc(desiredState)
	var (
		lastStatus contracts.SandboxStatus
		lastErr    error
		attempts   int
		retryable  bool
	)

	maxAttempts := r.maxRuntimeAttempts
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	for attempts = 1; attempts <= maxAttempts; attempts++ {
		lastStatus, lastErr = transitionFunc(ctx, sandboxID)
		if lastErr == nil {
			return lastStatus, nil, attempts, false
		}
		retryable = isRetryableRuntimeError(lastErr)
		if !retryable || attempts == maxAttempts {
			return lastStatus, lastErr, attempts, retryable
		}
		if waitErr := sleepWithContext(ctx, r.backoffDelay(attempts)); waitErr != nil {
			return lastStatus, waitErr, attempts, false
		}
	}
	return lastStatus, lastErr, attempts, retryable
}

func (r *Reconciler) transitionFunc(desiredState string) func(context.Context, string) (contracts.SandboxStatus, error) {
	switch desiredState {
	case desiredStateRunning:
		return r.supervisor.StartSandbox
	case desiredStateStopped:
		return r.supervisor.StopSandbox
	default:
		return r.supervisor.DestroySandbox
	}
}

func (r *Reconciler) backoffDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	backoff := r.baseBackoff * time.Duration(1<<(attempt-1))
	if backoff > r.maxBackoff {
		return r.maxBackoff
	}
	return backoff
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func normalizeDesiredState(desiredState string) string {
	switch strings.ToLower(strings.TrimSpace(desiredState)) {
	case desiredStateRunning, desiredStateStarted:
		return desiredStateRunning
	case desiredStateStopped:
		return desiredStateStopped
	case desiredStateDestroyed:
		return desiredStateDestroyed
	default:
		return ""
	}
}

func normalizeObservedState(observedState string) string {
	return strings.ToLower(strings.TrimSpace(observedState))
}

func isLegalTransition(observedState string, desiredState string) bool {
	current := normalizeObservedState(observedState)
	if current == "" {
		current = desiredStateStopped
	}

	switch desiredState {
	case desiredStateRunning:
		switch current {
		case desiredStateRunning, desiredStateStopped:
			return true
		default:
			return false
		}
	case desiredStateStopped:
		switch current {
		case desiredStateRunning, desiredStateStopped:
			return true
		default:
			return false
		}
	case desiredStateDestroyed:
		switch current {
		case desiredStateRunning, desiredStateStopped, desiredStateDestroyed:
			return true
		default:
			return false
		}
	default:
		return false
	}
}

func isRetryableRuntimeError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, vm.ErrSandboxNotFound) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}

	msg := strings.ToLower(err.Error())
	retryHints := []string{
		"timeout",
		"temporar",
		"try again",
		"unavailable",
		"busy",
		"connection reset",
		"connection refused",
		"resource exhausted",
		"eagain",
	}
	for _, hint := range retryHints {
		if strings.Contains(msg, hint) {
			return true
		}
	}
	return false
}

func encodeFailureReason(code string, message string, retryable bool, attempts int) string {
	payload := map[string]any{
		"code":    code,
		"message": message,
	}
	if retryable {
		payload["retryable"] = true
	}
	if attempts > 0 {
		payload["attempts"] = attempts
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Sprintf("%s: %s", code, message)
	}
	return string(encoded)
}
