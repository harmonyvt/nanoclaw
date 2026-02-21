package telegramagent

import "testing"

func TestSplitForTelegram_RespectsLimit(t *testing.T) {
	input := "one two three four five six seven eight nine ten"
	chunks := SplitForTelegram(input, 10)
	if len(chunks) < 2 {
		t.Fatalf("expected multiple chunks, got %d", len(chunks))
	}
	for _, chunk := range chunks {
		if len([]rune(chunk)) > 10 {
			t.Fatalf("chunk %q exceeds limit", chunk)
		}
	}
}

func TestSplitForTelegram_HandlesEmpty(t *testing.T) {
	chunks := SplitForTelegram("   ", 100)
	if len(chunks) != 0 {
		t.Fatalf("expected no chunks, got %d", len(chunks))
	}
}

func TestSplitForTelegram_UnicodeSafe(t *testing.T) {
	input := "😀😀😀😀😀😀"
	chunks := SplitForTelegram(input, 3)
	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d", len(chunks))
	}
	for _, chunk := range chunks {
		if len([]rune(chunk)) > 3 {
			t.Fatalf("chunk %q exceeds rune limit", chunk)
		}
	}
}
