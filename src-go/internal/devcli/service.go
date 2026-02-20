package devcli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Runner struct {
	workdir    string
	scriptPath string
	timeout    time.Duration
}

func NewRunner(workdir string) *Runner {
	return &Runner{
		workdir:    workdir,
		scriptPath: filepath.Join(workdir, "scripts", "remote-firecracker.sh"),
		timeout:    20 * time.Minute,
	}
}

func (r *Runner) Workdir() string {
	return r.workdir
}

func (r *Runner) ScriptPath() string {
	return r.scriptPath
}

func (r *Runner) Run(parent context.Context, args ...string) (string, error) {
	if _, err := os.Stat(r.scriptPath); err != nil {
		return "", fmt.Errorf("remote helper not found at %s: %w", r.scriptPath, err)
	}

	ctx := parent
	cancel := func() {}
	if r.timeout > 0 {
		ctx, cancel = context.WithTimeout(parent, r.timeout)
	}
	defer cancel()

	runArgs := append([]string{r.scriptPath}, args...)
	cmd := exec.CommandContext(ctx, "bash", runArgs...)
	cmd.Dir = r.workdir

	outputBytes, err := cmd.CombinedOutput()
	output := strings.TrimRight(string(outputBytes), "\n")
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return output, fmt.Errorf("command timed out after %s", r.timeout)
		}
		return output, err
	}
	return output, nil
}
