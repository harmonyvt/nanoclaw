package policy

import (
	"testing"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

func TestEvaluateRequiresEgressRules(t *testing.T) {
	eng := NewEngine("test-key")
	spec := contracts.TaskRunSpec{
		RiskClass: "high",
		CredentialRefs: contracts.CredentialRefs{
			TelegramBotTokenRef: "secret/vm/test/telegram",
			OpenAIAPIKeyRef:     "secret/vm/test/openai",
		},
		Capabilities: contracts.CapabilityPolicy{
			FSScopes: []contracts.PathScope{{Path: "/workspace", Mode: "write"}},
		},
	}
	decision := eng.Evaluate(spec)
	if decision.Allowed {
		t.Fatalf("expected policy denial when no egress rules")
	}
	if decision.Reason == "" {
		t.Fatalf("expected denial reason")
	}
}

func TestPathAndEgressChecks(t *testing.T) {
	eng := NewEngine("test-key")
	pol := contracts.CapabilityPolicy{
		FSScopes: []contracts.PathScope{
			{Path: "/workspace/project", Mode: "read"},
			{Path: "/workspace/tmp", Mode: "write"},
		},
		EgressRules: []contracts.EgressRule{{Host: "contracts.example.com", Port: 443}},
	}

	if eng.IsPathAllowed(pol, "/workspace/project/config.yml", true) {
		t.Fatalf("read-only scope should not allow writes")
	}
	if !eng.IsPathAllowed(pol, "/workspace/tmp/out.txt", true) {
		t.Fatalf("write scope should allow writes")
	}
	if !eng.IsEgressAllowed(pol, "contracts.example.com", 443) {
		t.Fatalf("expected allowed egress")
	}
	if eng.IsEgressAllowed(pol, "evil.example.com", 443) {
		t.Fatalf("unexpected egress allow")
	}
}

func TestSecretRevocationAndSignature(t *testing.T) {
	eng := NewEngine("test-key")
	eng.RevokeSecret("secret/db")
	spec := contracts.TaskRunSpec{
		RiskClass:  "high",
		SecretsRef: []string{"secret/db"},
		CredentialRefs: contracts.CredentialRefs{
			TelegramBotTokenRef: "secret/vm/test/telegram",
			OpenAIAPIKeyRef:     "secret/vm/test/openai",
		},
		Capabilities: contracts.CapabilityPolicy{
			EgressRules: []contracts.EgressRule{{Host: "*", Port: 443}},
		},
	}
	decision := eng.Evaluate(spec)
	if decision.Allowed {
		t.Fatalf("revoked secret should deny run")
	}
	if !eng.VerifySignature(spec, decision) {
		t.Fatalf("expected valid signature")
	}
}

func TestEvaluateRequiresCredentialRefs(t *testing.T) {
	eng := NewEngine("test-key")
	spec := contracts.TaskRunSpec{
		RiskClass: "high",
		Capabilities: contracts.CapabilityPolicy{
			EgressRules: []contracts.EgressRule{{Host: "api.example.com", Port: 443}},
		},
	}

	decision := eng.Evaluate(spec)
	if decision.Allowed {
		t.Fatalf("expected policy denial when credential refs are missing")
	}
	if decision.Reason == "" {
		t.Fatalf("expected denial reason")
	}
}
