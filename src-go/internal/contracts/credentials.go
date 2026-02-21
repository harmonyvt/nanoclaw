package contracts

import (
	"fmt"
	"strings"
)

func ValidateCredentialRefs(refs CredentialRefs) error {
	telegram := strings.TrimSpace(refs.TelegramBotTokenRef)
	openai := strings.TrimSpace(refs.OpenAIAPIKeyRef)

	switch {
	case telegram == "":
		return fmt.Errorf("credential_refs.telegram_bot_token_ref is required")
	case openai == "":
		return fmt.Errorf("credential_refs.openai_api_key_ref is required")
	case telegram == openai:
		return fmt.Errorf("credential_refs.telegram_bot_token_ref and credential_refs.openai_api_key_ref must be different")
	}

	return nil
}
