package telegramagent

import "testing"

func TestParseAllowedChatIDs(t *testing.T) {
	ids, err := ParseAllowedChatIDs("123,-456, 789")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(ids) != 3 {
		t.Fatalf("expected 3 ids, got %d", len(ids))
	}
	if _, ok := ids[123]; !ok {
		t.Fatalf("expected id 123")
	}
	if _, ok := ids[-456]; !ok {
		t.Fatalf("expected id -456")
	}
	if _, ok := ids[789]; !ok {
		t.Fatalf("expected id 789")
	}
}

func TestParseAllowedChatIDs_Invalid(t *testing.T) {
	_, err := ParseAllowedChatIDs("123,nope")
	if err == nil {
		t.Fatalf("expected error")
	}
}

func TestLoadConfigFromEnv_ModelFallback(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "tg-token")
	t.Setenv("OPENAI_API_KEY", "openai-token")
	t.Setenv("DEFAULT_MODEL", "gpt-test-model")
	t.Setenv("NANOCLAW_GO_AGENT_MODEL", "")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cfg.OpenAIModel != "gpt-test-model" {
		t.Fatalf("expected fallback model gpt-test-model, got %q", cfg.OpenAIModel)
	}
}

func TestLoadConfigFromEnv_RequiresSecrets(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "")
	t.Setenv("OPENAI_API_KEY", "")

	_, err := LoadConfigFromEnv()
	if err == nil {
		t.Fatalf("expected error")
	}
}
