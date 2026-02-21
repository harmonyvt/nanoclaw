package main

import (
	"context"
	"errors"
	"log"
	"os/signal"
	"strings"
	"syscall"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	openai "github.com/sashabaranov/go-openai"

	"github.com/harmony/nanoclaw/src-go/internal/telegramagent"
)

func main() {
	cfg, err := telegramagent.LoadConfigFromEnv()
	if err != nil {
		log.Fatalf("telegram-agent config error: %v", err)
	}
	if err := run(cfg); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("telegram-agent failed: %v", err)
	}
}

func run(cfg telegramagent.Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	bot, err := tgbotapi.NewBotAPI(cfg.TelegramBotToken)
	if err != nil {
		return err
	}
	bot.Debug = cfg.Debug
	log.Printf("telegram-agent authorized as @%s", bot.Self.UserName)

	openaiCfg := openai.DefaultConfig(cfg.OpenAIAPIKey)
	if cfg.OpenAIBaseURL != "" {
		openaiCfg.BaseURL = cfg.OpenAIBaseURL
	}
	aiClient := openai.NewClientWithConfig(openaiCfg)

	updatesCfg := tgbotapi.NewUpdate(0)
	updatesCfg.Timeout = int(cfg.PollTimeout.Seconds())
	updates := bot.GetUpdatesChan(updatesCfg)
	defer bot.StopReceivingUpdates()

	for {
		select {
		case <-ctx.Done():
			return nil
		case update, ok := <-updates:
			if !ok {
				return errors.New("telegram updates channel closed")
			}
			if update.Message == nil || strings.TrimSpace(update.Message.Text) == "" {
				continue
			}
			handleMessage(ctx, bot, aiClient, cfg, update.Message)
		}
	}
}

func handleMessage(
	ctx context.Context,
	bot *tgbotapi.BotAPI,
	aiClient *openai.Client,
	cfg telegramagent.Config,
	msg *tgbotapi.Message,
) {
	if !cfg.IsChatAllowed(msg.Chat.ID) {
		return
	}

	if msg.IsCommand() {
		handleCommand(bot, msg)
		return
	}

	userText := strings.TrimSpace(msg.Text)
	if userText == "" {
		return
	}

	_, _ = bot.Send(tgbotapi.NewChatAction(msg.Chat.ID, tgbotapi.ChatTyping))

	reply, err := generateReply(ctx, aiClient, cfg, userText)
	if err != nil {
		log.Printf("chat completion failed for chat=%d: %v", msg.Chat.ID, err)
		_, _ = bot.Send(tgbotapi.NewMessage(msg.Chat.ID, "I hit an AI error. Please try again."))
		return
	}

	chunks := telegramagent.SplitForTelegram(reply, 3500)
	if len(chunks) == 0 {
		chunks = []string{"(empty response)"}
	}

	for i, chunk := range chunks {
		out := tgbotapi.NewMessage(msg.Chat.ID, chunk)
		if i == 0 && msg.MessageID > 0 {
			out.ReplyToMessageID = msg.MessageID
		}
		if _, err := bot.Send(out); err != nil {
			log.Printf("send message failed for chat=%d: %v", msg.Chat.ID, err)
			return
		}
	}
}

func handleCommand(bot *tgbotapi.BotAPI, msg *tgbotapi.Message) {
	var text string
	switch msg.Command() {
	case "start", "help":
		text = "Send any text and I will reply using the configured OpenAI model."
	case "ping":
		text = "pong"
	default:
		text = "Unknown command. Use /help."
	}
	_, _ = bot.Send(tgbotapi.NewMessage(msg.Chat.ID, text))
}

func generateReply(
	ctx context.Context,
	client *openai.Client,
	cfg telegramagent.Config,
	userText string,
) (string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, cfg.RequestTimeout)
	defer cancel()

	resp, err := client.CreateChatCompletion(reqCtx, openai.ChatCompletionRequest{
		Model: cfg.OpenAIModel,
		Messages: []openai.ChatCompletionMessage{
			{
				Role:    openai.ChatMessageRoleSystem,
				Content: cfg.SystemPrompt,
			},
			{
				Role:    openai.ChatMessageRoleUser,
				Content: userText,
			},
		},
		Temperature: 0.2,
	})
	if err != nil {
		return "", err
	}
	if len(resp.Choices) == 0 {
		return "", errors.New("openai returned no choices")
	}
	answer := strings.TrimSpace(resp.Choices[0].Message.Content)
	if answer == "" {
		return "I could not generate a response.", nil
	}
	return answer, nil
}
