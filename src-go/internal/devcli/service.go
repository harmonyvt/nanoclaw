package devcli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

type ServiceState string

const (
	StateStopped  ServiceState = "stopped"
	StateStarting ServiceState = "starting"
	StateRunning  ServiceState = "running"
	StateStopping ServiceState = "stopping"
	StateFailed   ServiceState = "failed"
)

type ServiceSpec struct {
	Name        string
	PackagePath string
	Env         map[string]string
}

type Service struct {
	spec    ServiceSpec
	workdir string

	mu        sync.RWMutex
	cmd       *exec.Cmd
	state     ServiceState
	startedAt time.Time
	lastErr   string
	logLines  []string
	maxLogs   int
}

func NewService(workdir string, spec ServiceSpec) *Service {
	return &Service{
		spec:    spec,
		workdir: workdir,
		state:   StateStopped,
		maxLogs: 200,
	}
}

func (s *Service) Spec() ServiceSpec {
	return s.spec
}

func (s *Service) State() ServiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state
}

func (s *Service) LastError() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastErr
}

func (s *Service) Uptime() time.Duration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.state != StateRunning {
		return 0
	}
	return time.Since(s.startedAt)
}

func (s *Service) Logs(limit int) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 || len(s.logLines) <= limit {
		return append([]string(nil), s.logLines...)
	}
	return append([]string(nil), s.logLines[len(s.logLines)-limit:]...)
}

func (s *Service) Start() error {
	s.mu.Lock()
	if s.state == StateRunning || s.state == StateStarting || s.state == StateStopping {
		s.mu.Unlock()
		return fmt.Errorf("service is %s", s.state)
	}
	s.state = StateStarting
	s.lastErr = ""
	cmd := exec.Command("go", "run", s.spec.PackagePath)
	cmd.Dir = s.workdir
	cmd.Env = append(os.Environ(), envPairs(s.spec.Env)...)
	if runtime.GOOS != "windows" {
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Setpgid: true,
		}
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.state = StateFailed
		s.lastErr = err.Error()
		s.mu.Unlock()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		s.state = StateFailed
		s.lastErr = err.Error()
		s.mu.Unlock()
		return err
	}

	if err := cmd.Start(); err != nil {
		s.state = StateFailed
		s.lastErr = err.Error()
		s.appendLogLocked("start failed: " + err.Error())
		s.mu.Unlock()
		return err
	}

	s.cmd = cmd
	s.state = StateRunning
	s.startedAt = time.Now()
	s.appendLogLocked("started")
	s.mu.Unlock()

	go s.capture(stdout, "out")
	go s.capture(stderr, "err")
	go s.wait(cmd)
	return nil
}

func (s *Service) Stop(timeout time.Duration) error {
	s.mu.Lock()
	if s.state == StateStopping {
		s.mu.Unlock()
		return nil
	}
	cmd := s.cmd
	if cmd == nil || cmd.Process == nil || s.state == StateStopped {
		s.mu.Unlock()
		return nil
	}
	s.state = StateStopping
	s.appendLogLocked("stopping")
	s.mu.Unlock()

	if runtime.GOOS == "windows" {
		_ = cmd.Process.Kill()
	} else {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGINT)
	}

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		state := s.State()
		if state == StateStopped || state == StateFailed {
			return nil
		}
		time.Sleep(120 * time.Millisecond)
	}

	s.mu.RLock()
	cmd = s.cmd
	s.mu.RUnlock()
	if cmd != nil && cmd.Process != nil {
		pid := cmd.Process.Pid
		if runtime.GOOS == "windows" {
			_ = cmd.Process.Kill()
		} else {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		}
	}

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		state := s.State()
		if state == StateStopped || state == StateFailed {
			return nil
		}
		time.Sleep(120 * time.Millisecond)
	}
	s.mu.Lock()
	s.lastErr = "stop timed out"
	s.state = StateFailed
	s.appendLogLocked("stop timed out")
	s.mu.Unlock()

	return errors.New("stop timed out")
}

func (s *Service) wait(cmd *exec.Cmd) {
	err := cmd.Wait()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != cmd {
		return
	}

	if err != nil {
		// Interrupt exits should appear as clean stop for local workflows.
		if strings.Contains(err.Error(), "signal: interrupt") {
			s.state = StateStopped
		} else {
			s.state = StateFailed
			s.lastErr = err.Error()
			s.appendLogLocked("exited with error: " + err.Error())
		}
	} else {
		s.state = StateStopped
		s.appendLogLocked("exited")
	}
	s.cmd = nil
}

func (s *Service) capture(reader io.Reader, stream string) {
	scanner := bufio.NewScanner(reader)
	buffer := make([]byte, 0, 64*1024)
	scanner.Buffer(buffer, 1024*1024)
	for scanner.Scan() {
		s.appendLog(stream + " | " + scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		s.appendLog(fmt.Sprintf("%s stream error: %v", stream, err))
	}
}

func (s *Service) appendLog(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendLogLocked(line)
}

func (s *Service) appendLogLocked(line string) {
	s.logLines = append(s.logLines, fmt.Sprintf("%s %s", time.Now().Format("15:04:05"), line))
	if len(s.logLines) > s.maxLogs {
		s.logLines = s.logLines[len(s.logLines)-s.maxLogs:]
	}
}

func envPairs(values map[string]string) []string {
	if len(values) == 0 {
		return nil
	}
	pairs := make([]string, 0, len(values))
	for key, value := range values {
		pairs = append(pairs, fmt.Sprintf("%s=%s", key, value))
	}
	return pairs
}
