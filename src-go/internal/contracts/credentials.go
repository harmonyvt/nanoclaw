package contracts

import (
	"fmt"
	"strings"
)

func ValidateCredentialRefs(refs CredentialRefs) error {
	normalized := NormalizeCredentialRefs(refs)
	telegram := normalized.TelegramBotTokenRef
	openai := normalized.OpenAIAPIKeyRef

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

func NormalizeCredentialRefs(refs CredentialRefs) CredentialRefs {
	refs.TelegramBotTokenRef = strings.TrimSpace(refs.TelegramBotTokenRef)
	refs.OpenAIAPIKeyRef = strings.TrimSpace(refs.OpenAIAPIKeyRef)
	return refs
}

func CredentialLockApplies(observedState string) bool {
	state := strings.ToLower(strings.TrimSpace(observedState))
	return state != "destroyed"
}
