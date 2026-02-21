package telegramagent

import (
	"strings"
	"unicode"
)

func SplitForTelegram(text string, maxRunes int) []string {
	if maxRunes <= 0 {
		maxRunes = 3500
	}

	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	var chunks []string
	remaining := []rune(text)
	for len(remaining) > 0 {
		if len(remaining) <= maxRunes {
			chunk := strings.TrimSpace(string(remaining))
			if chunk != "" {
				chunks = append(chunks, chunk)
			}
			break
		}

		splitAt := preferredSplit(remaining, maxRunes)
		chunk := strings.TrimSpace(string(remaining[:splitAt]))
		if chunk != "" {
			chunks = append(chunks, chunk)
		}
		remaining = trimLeadingSpace(remaining[splitAt:])
	}

	return chunks
}

func preferredSplit(runes []rune, limit int) int {
	if limit >= len(runes) {
		return len(runes)
	}
	if limit <= 1 {
		return 1
	}

	minSearch := limit / 2
	if minSearch < 1 {
		minSearch = 1
	}
	for i := limit; i >= minSearch; i-- {
		r := runes[i-1]
		if r == '\n' || unicode.IsSpace(r) {
			return i
		}
	}
	return limit
}

func trimLeadingSpace(runes []rune) []rune {
	for len(runes) > 0 && unicode.IsSpace(runes[0]) {
		runes = runes[1:]
	}
	return runes
}
