package main

import (
	"context"
	"errors"
	"strings"
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
