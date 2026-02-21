package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

type credentialValidationBackend struct {
	createStatus contracts.SandboxStatus
	getStatusFn  func(context.Context, contracts.SandboxStatus) (contracts.SandboxStatus, error)
}

func (b *credentialValidationBackend) Name() string {
	return vm.BackendSimulated
}

func (b *credentialValidationBackend) CreateSandbox(_ context.Context, spec contracts.SandboxSpec) (contracts.SandboxStatus, error) {
	status := b.createStatus
	if status.SandboxID == "" {
		status.SandboxID = spec.SandboxID
	}
	if status.ObservedState == "" {
		status.ObservedState = "running"
	}
	if status.Health == "" {
		status.Health = "healthy"
	}
	return status, nil
}

func (b *credentialValidationBackend) StartSandbox(_ context.Context, _ contracts.SandboxSpec, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	return current, nil
}

func (b *credentialValidationBackend) StopSandbox(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	return current, nil
}

func (b *credentialValidationBackend) SnapshotSandbox(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	return current, nil
}

func (b *credentialValidationBackend) DestroySandbox(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	return current, nil
}

func (b *credentialValidationBackend) KillSwitch(_ context.Context, current contracts.SandboxStatus, _ string) (contracts.SandboxStatus, error) {
	return current, nil
}

func (b *credentialValidationBackend) GetStatus(ctx context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
	if b.getStatusFn != nil {
		return b.getStatusFn(ctx, current)
	}
	return current, nil
}

func (b *credentialValidationBackend) Summary() map[string]any {
	return map[string]any{"backend": b.Name()}
}

func TestValidateSandboxCredentialRefsIgnoresDestroyedSandboxWithTrimmedState(t *testing.T) {
	backend := &credentialValidationBackend{}
	backend.getStatusFn = func(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		current.ObservedState = " Destroyed "
		return current, nil
	}
	sup := vm.NewSupervisorWithBackend(backend)

	existing := contracts.SandboxSpec{
		SandboxID: "sbx-1",
		CredentialRefs: contracts.CredentialRefs{
			TelegramBotTokenRef: "secret/vm/shared/telegram",
			OpenAIAPIKeyRef:     "secret/vm/shared/openai",
		},
	}
	_ = sup.CreateSandbox(existing)

	incoming := contracts.SandboxSpec{
		SandboxID: "sbx-2",
		CredentialRefs: contracts.CredentialRefs{
			TelegramBotTokenRef: "secret/vm/shared/telegram",
			OpenAIAPIKeyRef:     "secret/vm/shared/openai",
		},
	}
	if err := validateSandboxCredentialRefs(sup, incoming); err != nil {
		t.Fatalf("expected destroyed sandbox to release credential lock, got %v", err)
	}
}

func TestValidateSandboxCredentialRefsLocksCredentialsOnStatusLookupError(t *testing.T) {
	backend := &credentialValidationBackend{}
	backend.getStatusFn = func(_ context.Context, current contracts.SandboxStatus) (contracts.SandboxStatus, error) {
		return contracts.SandboxStatus{}, errors.New("status unavailable")
	}
	sup := vm.NewSupervisorWithBackend(backend)

	existing := contracts.SandboxSpec{
		SandboxID: "sbx-1",
		CredentialRefs: contracts.CredentialRefs{
			TelegramBotTokenRef: "secret/vm/shared/telegram",
			OpenAIAPIKeyRef:     "secret/vm/shared/openai",
		},
	}
	_ = sup.CreateSandbox(existing)

	incoming := contracts.SandboxSpec{
		SandboxID: "sbx-2",
		CredentialRefs: contracts.CredentialRefs{
			TelegramBotTokenRef: "secret/vm/shared/telegram",
			OpenAIAPIKeyRef:     "secret/vm/new/openai",
		},
	}
	err := validateSandboxCredentialRefs(sup, incoming)
	if err == nil {
		t.Fatalf("expected credential lock to apply when status lookup fails")
	}
	if !strings.Contains(err.Error(), "already allocated") {
		t.Fatalf("expected allocation conflict error, got %v", err)
	}
}

func TestValidateSandboxCredentialRefsAllowsRebindForWhitespaceOnlyRefs(t *testing.T) {
	sup := vm.NewSupervisor(true, "")
	existing := contracts.SandboxSpec{
		SandboxID: "sbx-1",
		CredentialRefs: contracts.CredentialRefs{
			TelegramBotTokenRef: " ",
			OpenAIAPIKeyRef:     "\t",
		},
	}
	_ = sup.CreateSandbox(existing)

	incoming := contracts.SandboxSpec{
		SandboxID: "sbx-1",
		CredentialRefs: contracts.CredentialRefs{
			TelegramBotTokenRef: "secret/vm/new/telegram",
			OpenAIAPIKeyRef:     "secret/vm/new/openai",
		},
	}
	if err := validateSandboxCredentialRefs(sup, incoming); err != nil {
		t.Fatalf("expected whitespace-only refs to be treated as unbound, got %v", err)
	}
}

func TestSandboxCreateHandlerSerializesCredentialReservationUnderConcurrency(t *testing.T) {
	sup := vm.NewSupervisor(true, "")
	handler := newSandboxCreateHandler(sup)

	const requests = 12
	start := make(chan struct{})
	codes := make(chan int, requests)
	var wg sync.WaitGroup

	for i := 0; i < requests; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start

			spec := contracts.SandboxSpec{
				SandboxID: fmt.Sprintf("sbx-%d", i),
				CredentialRefs: contracts.CredentialRefs{
					TelegramBotTokenRef: "secret/vm/shared/telegram",
					OpenAIAPIKeyRef:     "secret/vm/shared/openai",
				},
			}
			raw, _ := json.Marshal(spec)
			req := httptest.NewRequest(http.MethodPost, "/v1/supervisor/sandboxes", bytes.NewReader(raw))
			resp := httptest.NewRecorder()
			handler(resp, req)
			codes <- resp.Code
		}()
	}

	close(start)
	wg.Wait()
	close(codes)

	created := 0
	conflicts := 0
	for code := range codes {
		switch code {
		case http.StatusOK:
			created++
		case http.StatusConflict:
			conflicts++
		default:
			t.Fatalf("expected only ok/conflict responses, got %d", code)
		}
	}
	if created != 1 {
		t.Fatalf("expected exactly one successful create, got %d", created)
	}
	if conflicts != requests-1 {
		t.Fatalf("expected %d conflicts, got %d", requests-1, conflicts)
	}
}

func TestSandboxCreateHandlerReturnsBadRequestForInvalidCredentialRefs(t *testing.T) {
	sup := vm.NewSupervisor(true, "")
	handler := newSandboxCreateHandler(sup)

	spec := contracts.SandboxSpec{
		SandboxID: "sbx-invalid",
		CredentialRefs: contracts.CredentialRefs{
			TelegramBotTokenRef: "",
			OpenAIAPIKeyRef:     "secret/vm/shared/openai",
		},
	}
	raw, _ := json.Marshal(spec)
	req := httptest.NewRequest(http.MethodPost, "/v1/supervisor/sandboxes", bytes.NewReader(raw))
	resp := httptest.NewRecorder()
	handler(resp, req)

	if resp.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request for invalid credential refs, got %d: %s", resp.Code, resp.Body.String())
	}
}
