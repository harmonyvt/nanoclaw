package telegramagent

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultSystemPrompt = "You are NanoClaw, a concise and practical engineering assistant."

type Config struct {
	TelegramBotToken string
	OpenAIAPIKey     string
	OpenAIBaseURL    string
	OpenAIModel      string
	SystemPrompt     string
	PollTimeout      time.Duration
	RequestTimeout   time.Duration
	AllowedChatIDs   map[int64]struct{}
	Debug            bool
}

func (c Config) IsChatAllowed(chatID int64) bool {
	if len(c.AllowedChatIDs) == 0 {
		return true
	}
	_, ok := c.AllowedChatIDs[chatID]
	return ok
}

func LoadConfigFromEnv() (Config, error) {
	modelFallback := strings.TrimSpace(os.Getenv("DEFAULT_MODEL"))
	if modelFallback == "" {
		modelFallback = "gpt-4o-mini"
	}

	pollSeconds := getenvInt("NANOCLAW_GO_TELEGRAM_POLL_SECONDS", 30)
	if pollSeconds <= 0 {
		pollSeconds = 30
	}
	timeoutSeconds := getenvInt("NANOCLAW_GO_AGENT_TIMEOUT_SECONDS", 60)
	if timeoutSeconds <= 0 {
		timeoutSeconds = 60
	}

	allowedIDsRaw := strings.TrimSpace(os.Getenv("NANOCLAW_GO_TELEGRAM_ALLOWED_CHAT_IDS"))
	if allowedIDsRaw == "" {
		allowedIDsRaw = strings.TrimSpace(os.Getenv("TELEGRAM_ALLOWED_CHAT_IDS"))
	}
	allowedIDs, err := ParseAllowedChatIDs(allowedIDsRaw)
	if err != nil {
		return Config{}, fmt.Errorf("parse allowed chat ids: %w", err)
	}

	cfg := Config{
		TelegramBotToken: strings.TrimSpace(os.Getenv("TELEGRAM_BOT_TOKEN")),
		OpenAIAPIKey:     strings.TrimSpace(os.Getenv("OPENAI_API_KEY")),
		OpenAIBaseURL:    strings.TrimSpace(os.Getenv("OPENAI_BASE_URL")),
		OpenAIModel:      strings.TrimSpace(getenv("NANOCLAW_GO_AGENT_MODEL", modelFallback)),
		SystemPrompt:     strings.TrimSpace(getenv("NANOCLAW_GO_AGENT_SYSTEM_PROMPT", defaultSystemPrompt)),
		PollTimeout:      time.Duration(pollSeconds) * time.Second,
		RequestTimeout:   time.Duration(timeoutSeconds) * time.Second,
		AllowedChatIDs:   allowedIDs,
		Debug:            getenvBool("NANOCLAW_GO_TELEGRAM_DEBUG", false),
	}

	switch {
	case cfg.TelegramBotToken == "":
		return Config{}, fmt.Errorf("missing TELEGRAM_BOT_TOKEN")
	case cfg.OpenAIAPIKey == "":
		return Config{}, fmt.Errorf("missing OPENAI_API_KEY")
	case cfg.OpenAIModel == "":
		return Config{}, fmt.Errorf("missing NANOCLAW_GO_AGENT_MODEL (or DEFAULT_MODEL)")
	}

	return cfg, nil
}

func ParseAllowedChatIDs(raw string) (map[int64]struct{}, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}

	allowed := make(map[int64]struct{})
	parts := strings.Split(raw, ",")
	for _, part := range parts {
		token := strings.TrimSpace(part)
		if token == "" {
			continue
		}
		id, err := strconv.ParseInt(token, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid chat id %q", token)
		}
		allowed[id] = struct{}{}
	}

	return allowed, nil
}

func getenv(key, fallback string) string {
	value := os.Getenv(key)
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func getenvInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getenvBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
