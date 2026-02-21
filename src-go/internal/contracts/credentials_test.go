package contracts

import "testing"

func TestNormalizeCredentialRefsTrimsWhitespace(t *testing.T) {
	refs := NormalizeCredentialRefs(CredentialRefs{
		TelegramBotTokenRef: " secret/vm/test/telegram ",
		OpenAIAPIKeyRef:     "\tsecret/vm/test/openai\n",
	})

	if refs.TelegramBotTokenRef != "secret/vm/test/telegram" {
		t.Fatalf("expected trimmed telegram ref, got %q", refs.TelegramBotTokenRef)
	}
	if refs.OpenAIAPIKeyRef != "secret/vm/test/openai" {
		t.Fatalf("expected trimmed openai ref, got %q", refs.OpenAIAPIKeyRef)
	}
}

func TestValidateCredentialRefsRejectsWhitespaceOnly(t *testing.T) {
	err := ValidateCredentialRefs(CredentialRefs{
		TelegramBotTokenRef: "   ",
		OpenAIAPIKeyRef:     "secret/vm/test/openai",
	})
	if err == nil {
		t.Fatalf("expected whitespace-only telegram ref to be rejected")
	}
}

func TestValidateCredentialRefsRejectsEquivalentRefsAfterTrim(t *testing.T) {
	err := ValidateCredentialRefs(CredentialRefs{
		TelegramBotTokenRef: " secret/vm/shared/ref",
		OpenAIAPIKeyRef:     "secret/vm/shared/ref ",
	})
	if err == nil {
		t.Fatalf("expected refs that only differ by whitespace to be rejected")
	}
}

func TestCredentialLockApplies(t *testing.T) {
	tests := []struct {
		name          string
		observedState string
		want          bool
	}{
		{name: "running", observedState: "running", want: true},
		{name: "destroyed", observedState: "destroyed", want: false},
		{name: "destroyed with spacing and case", observedState: " DeStRoYeD ", want: false},
		{name: "empty", observedState: "", want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CredentialLockApplies(tt.observedState); got != tt.want {
				t.Fatalf("CredentialLockApplies(%q) = %v, want %v", tt.observedState, got, tt.want)
			}
		})
	}
}
