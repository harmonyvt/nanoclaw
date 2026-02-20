package firecracker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

func launchFirecrackerProcess(binaryPath, runtimeDir, apiSocket string) (*exec.Cmd, error) {
	if binaryPath == "" {
		return nil, errors.New("firecracker binary path is required")
	}
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		return nil, err
	}
	stdoutPath := filepath.Join(runtimeDir, "firecracker.stdout.log")
	stderrPath := filepath.Join(runtimeDir, "firecracker.stderr.log")
	stdout, err := os.OpenFile(stdoutPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	stderr, err := os.OpenFile(stderrPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		_ = stdout.Close()
		return nil, err
	}

	cmd := exec.Command(binaryPath, "--api-sock", apiSocket)
	cmd.Dir = runtimeDir
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		_ = stdout.Close()
		_ = stderr.Close()
		return nil, err
	}
	// Child keeps its own FDs after start; close parent copies to avoid leaks.
	_ = stdout.Close()
	_ = stderr.Close()
	return cmd, nil
}

func waitForAPISocket(ctx context.Context, socketPath string) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if fileInfo, err := os.Stat(socketPath); err == nil && fileInfo.Mode()&os.ModeSocket != 0 {
			d := net.Dialer{Timeout: 200 * time.Millisecond}
			conn, dialErr := d.DialContext(ctx, "unix", socketPath)
			if dialErr == nil {
				_ = conn.Close()
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("timeout waiting for firecracker api socket %s: %w", socketPath, ctx.Err())
		case <-ticker.C:
		}
	}
}

func isRunning(cmd *exec.Cmd) bool {
	if cmd == nil || cmd.Process == nil {
		return false
	}
	err := cmd.Process.Signal(syscall.Signal(0))
	return err == nil
}

func exitCodeFromErr(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}
