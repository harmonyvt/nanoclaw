package firecracker

import (
	"os/exec"
	"time"
)

type runtimeState struct {
	sandboxID  string
	vmID       string
	runtimeDir string
	apiSocket  string

	cmd      *exec.Cmd
	starting bool
	pid      int
	waitDone chan struct{}
	waitErr  error

	lastExitCode int
	snapshotRef  string

	createdAt time.Time
}
