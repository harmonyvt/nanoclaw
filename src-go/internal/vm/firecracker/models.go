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
	// startupCancel/startupDone coordinate stop requests that arrive while
	// StartSandbox is still bringing up the VM and rt.cmd is not yet stable.
	startupCancel func()
	startupDone   chan struct{}
	pid           int
	waitDone      chan struct{}
	waitErr       error

	lastExitCode int
	snapshotRef  string

	createdAt time.Time
}
