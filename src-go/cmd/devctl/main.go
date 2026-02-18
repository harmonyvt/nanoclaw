package main

import (
	"log"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/harmony/nanoclaw/src-go/internal/devcli"
)

func main() {
	workdir, err := os.Getwd()
	if err != nil {
		log.Fatalf("resolve workdir: %v", err)
	}

	model := devcli.NewModel(workdir)
	defer model.Shutdown()

	program := tea.NewProgram(model, tea.WithAltScreen())
	if _, err := program.Run(); err != nil {
		log.Fatalf("devctl failed: %v", err)
	}
}
