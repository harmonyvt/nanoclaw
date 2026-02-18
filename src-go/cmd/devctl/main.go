package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/harmony/nanoclaw/src-go/internal/devcli"
)

func main() {
	workdir, err := resolveWorkdir()
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

func resolveWorkdir() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}

	if wd, ok := locateGoModule(cwd); ok {
		return wd, nil
	}
	return "", fmt.Errorf("unable to locate src-go module from %s", cwd)
}

func locateGoModule(start string) (string, bool) {
	current := filepath.Clean(start)
	for {
		if hasGoMod(current) {
			return current, true
		}

		moduleCandidate := filepath.Join(current, "src-go")
		if hasGoMod(moduleCandidate) {
			return moduleCandidate, true
		}

		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return "", false
}

func hasGoMod(path string) bool {
	info, err := os.Stat(filepath.Join(path, "go.mod"))
	return err == nil && !info.IsDir()
}
