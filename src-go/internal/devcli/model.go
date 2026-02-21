package devcli

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type commandResultMsg struct {
	command    commandSpec
	output     string
	err        error
	duration   time.Duration
	finishedAt time.Time
}

type tickMsg time.Time

type commandSpec struct {
	key           string
	title         string
	args          []string
	description   string
	refreshStatus bool
}

type runRecord struct {
	title      string
	ok         bool
	finishedAt time.Time
	duration   time.Duration
}

type remoteServiceState struct {
	process string
	health  string
}

type remoteSnapshot struct {
	services   map[string]remoteServiceState
	capturedAt time.Time
}

type remoteConfig struct {
	envFile        string
	host           string
	remoteWorkdir  string
	remoteSrcGoDir string
	firecrackerBin string
	kernelImage    string
	rootfsImage    string
	netMode        string
}

type Model struct {
	runner  *Runner
	cursor  int
	width   int
	height  int
	status  string
	busy    bool
	running string

	commands []commandSpec
	remote   remoteConfig
	snapshot remoteSnapshot
	history  []runRecord

	outputLabel string
	output      string
	busySince   time.Time
}

func NewModel(workdir string) *Model {
	model := &Model{
		runner:      NewRunner(workdir),
		commands:    defaultCommands(),
		remote:      loadRemoteConfig(workdir),
		status:      "Remote dashboard ready. Press Enter to run a Telegram runtime action.",
		outputLabel: "No command run yet",
		output:      "",
		snapshot:    remoteSnapshot{services: map[string]remoteServiceState{}},
		history:     nil,
		running:     "",
		busy:        false,
		busySince:   time.Time{},
		cursor:      0,
		width:       0,
		height:      0,
	}
	model.clampCursor()
	return model
}

func (m *Model) Init() tea.Cmd {
	bootStatus := m.startCommandByKey("status")
	return tea.Batch(m.tickCmd(), bootStatus)
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.clampCursor()
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.commands)-1 {
				m.cursor++
			}
		case "enter", " ":
			if !m.busy {
				selected := m.selectedCommand()
				if selected != nil {
					return m, m.startCommand(*selected)
				}
			}
		case "u":
			return m, m.startCommandByKey("up")
		case "d":
			return m, m.startCommandByKey("down")
		case "r":
			return m, m.startCommandByKey("restart")
		case "s":
			return m, m.startCommandByKey("sync")
		case "h":
			return m, m.startCommandByKey("status")
		case "m":
			return m, m.startCommandByKey("smoke")
		case "l":
			return m, m.startCommandByKey("logs_all")
		case "t":
			return m, m.startCommandByKey("test")
		case "g":
			return m, m.startCommandByKey("doctor")
		case "e":
			m.remote = loadRemoteConfig(m.runner.Workdir())
			m.status = fmt.Sprintf("reloaded remote config from %s", m.remote.envFile)
		case "c":
			m.output = ""
			m.outputLabel = "Output cleared"
			m.status = "cleared output panel"
		}
		return m, nil
	case commandResultMsg:
		m.busy = false
		m.running = ""
		m.outputLabel = fmt.Sprintf("%s (%s)", msg.command.title, msg.finishedAt.Format("15:04:05"))
		m.output = msg.output
		m.pushHistory(runRecord{
			title:      msg.command.title,
			ok:         msg.err == nil,
			duration:   msg.duration,
			finishedAt: msg.finishedAt,
		})

		if msg.err != nil {
			m.status = fmt.Sprintf("%s failed in %s: %v", msg.command.title, formatDuration(msg.duration), msg.err)
		} else {
			m.status = fmt.Sprintf("%s completed in %s", msg.command.title, formatDuration(msg.duration))
		}

		if msg.command.key == "status" && msg.err == nil {
			parsed := parseStatusOutput(msg.output)
			if len(parsed) > 0 {
				m.snapshot = remoteSnapshot{
					services:   parsed,
					capturedAt: msg.finishedAt,
				}
			}
		}

		if msg.command.refreshStatus && msg.err == nil {
			return m, m.startCommandByKey("status")
		}
		return m, nil
	case tickMsg:
		return m, m.tickCmd()
	default:
		return m, nil
	}
}

func (m *Model) View() string {
	var builder strings.Builder

	title := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("69")).Render("NanoClaw Remote MicroVM Dashboard")
	subtitle := lipgloss.NewStyle().Foreground(lipgloss.Color("246")).Render("Remote-only devctl for Telegram agent runtime operations on Firecracker hosts")
	builder.WriteString(title)
	builder.WriteString("\n")
	builder.WriteString(subtitle)
	builder.WriteString("\n\n")

	builder.WriteString(lipgloss.NewStyle().Bold(true).Render("Remote Target"))
	builder.WriteString("\n")
	builder.WriteString(m.dimLine(fmt.Sprintf("env_file=%s", displayOrUnset(m.remote.envFile))))
	builder.WriteString("\n")
	builder.WriteString(fmt.Sprintf("host=%s | remote_workdir=%s", displayOrUnset(m.remote.host), displayOrUnset(m.remote.remoteWorkdir)))
	builder.WriteString("\n")
	builder.WriteString(fmt.Sprintf("remote_src_go=%s", displayOrUnset(m.remote.remoteSrcGoDir)))
	builder.WriteString("\n")
	builder.WriteString(fmt.Sprintf("firecracker_bin=%s", displayOrUnset(m.remote.firecrackerBin)))
	builder.WriteString("\n")
	builder.WriteString(fmt.Sprintf("kernel_image=%s | rootfs_image=%s | vm_net_mode=%s", displayOrUnset(m.remote.kernelImage), displayOrUnset(m.remote.rootfsImage), displayOrUnset(m.remote.netMode)))
	builder.WriteString("\n\n")

	builder.WriteString(lipgloss.NewStyle().Bold(true).Render("Actions"))
	builder.WriteString("\n")
	for idx, command := range m.commands {
		pointer := "  "
		if idx == m.cursor {
			pointer = "> "
		}
		row := fmt.Sprintf("%s%-18s %s", pointer, command.title, command.description)
		if m.busy && command.key == m.running {
			row = lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Render(row + " [running]")
		}
		builder.WriteString(m.clipLine(row))
		builder.WriteString("\n")
	}
	builder.WriteString("\n")

	builder.WriteString(lipgloss.NewStyle().Bold(true).Render("Remote Service Health"))
	builder.WriteString("\n")
	if len(m.snapshot.services) == 0 {
		builder.WriteString(m.dimLine("(run status to populate health snapshot)"))
		builder.WriteString("\n")
	} else {
		for _, name := range []string{"nanoclawd", "sessiond", "vm-supervisor"} {
			state := m.snapshot.services[name]
			process := displayOrUnset(state.process)
			health := displayOrUnset(state.health)
			line := fmt.Sprintf("%-13s process=%-8s health=%s", name, process, health)
			builder.WriteString(m.clipLine(line))
			builder.WriteString("\n")
		}
		builder.WriteString(m.dimLine(fmt.Sprintf("last status refresh: %s", m.snapshot.capturedAt.Format("15:04:05"))))
		builder.WriteString("\n")
	}
	builder.WriteString("\n")

	builder.WriteString(lipgloss.NewStyle().Bold(true).Render("Output"))
	builder.WriteString("\n")
	builder.WriteString(m.dimLine(m.outputLabel))
	builder.WriteString("\n")
	if m.busy {
		active := m.running
		if active == "" {
			active = "command"
		}
		builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Render(
			fmt.Sprintf("%s running for %s", active, formatDuration(time.Since(m.busySince))),
		))
		builder.WriteString("\n")
	}

	outputLines := tailLines(m.output, 12)
	if len(outputLines) == 0 {
		builder.WriteString(m.dimLine("(no output)"))
		builder.WriteString("\n")
	} else {
		for _, line := range outputLines {
			builder.WriteString(m.clipLine(line))
			builder.WriteString("\n")
		}
	}
	builder.WriteString("\n")

	builder.WriteString(lipgloss.NewStyle().Bold(true).Render("Recent Commands"))
	builder.WriteString("\n")
	if len(m.history) == 0 {
		builder.WriteString(m.dimLine("(no history yet)"))
		builder.WriteString("\n")
	} else {
		for _, item := range m.history {
			status := "ok"
			style := lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
			if !item.ok {
				status = "failed"
				style = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
			}
			line := fmt.Sprintf("%s %-18s %-6s %s", item.finishedAt.Format("15:04:05"), item.title, status, formatDuration(item.duration))
			builder.WriteString(style.Render(m.clipLine(line)))
			builder.WriteString("\n")
		}
	}
	builder.WriteString("\n")

	builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("220")).Render(m.status))
	builder.WriteString("\n")
	builder.WriteString(m.dimLine("keys: up/down select | enter run | g doctor | s sync | u up | h status | m smoke | l logs | t test | d down | r restart | e reload env | c clear output | q quit"))
	builder.WriteString("\n")
	builder.WriteString(m.dimLine(fmt.Sprintf("helper: %s", m.runner.ScriptPath())))
	builder.WriteString("\n")

	return builder.String()
}

func (m *Model) Shutdown() {}

func (m *Model) selectedCommand() *commandSpec {
	if len(m.commands) == 0 || m.cursor < 0 || m.cursor >= len(m.commands) {
		return nil
	}
	return &m.commands[m.cursor]
}

func (m *Model) clampCursor() {
	if len(m.commands) == 0 {
		m.cursor = 0
		return
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.cursor >= len(m.commands) {
		m.cursor = len(m.commands) - 1
	}
}

func (m *Model) startCommandByKey(key string) tea.Cmd {
	if m.busy {
		return nil
	}
	command, ok := m.findCommand(key)
	if !ok {
		return nil
	}
	return m.startCommand(command)
}

func (m *Model) findCommand(key string) (commandSpec, bool) {
	for _, command := range m.commands {
		if command.key == key {
			return command, true
		}
	}
	return commandSpec{}, false
}

func (m *Model) startCommand(command commandSpec) tea.Cmd {
	if m.busy {
		return nil
	}

	m.busy = true
	m.running = command.key
	m.busySince = time.Now()
	m.status = fmt.Sprintf("running %s...", command.title)

	runner := m.runner
	return func() tea.Msg {
		start := time.Now()
		output, err := runner.Run(context.Background(), command.args...)
		return commandResultMsg{
			command:    command,
			output:     output,
			err:        err,
			duration:   time.Since(start),
			finishedAt: time.Now(),
		}
	}
}

func (m *Model) tickCmd() tea.Cmd {
	return tea.Tick(350*time.Millisecond, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m *Model) pushHistory(item runRecord) {
	m.history = append([]runRecord{item}, m.history...)
	if len(m.history) > 8 {
		m.history = m.history[:8]
	}
}

func (m *Model) clipLine(line string) string {
	maxWidth := 120
	if m.width > 0 {
		maxWidth = m.width - 2
	}
	if maxWidth < 20 {
		maxWidth = 20
	}
	if len(line) <= maxWidth {
		return line
	}
	if maxWidth <= 3 {
		return line[:maxWidth]
	}
	return line[:maxWidth-3] + "..."
}

func (m *Model) dimLine(value string) string {
	return lipgloss.NewStyle().Foreground(lipgloss.Color("245")).Render(value)
}

func defaultCommands() []commandSpec {
	return []commandSpec{
		{
			key:         "doctor",
			title:       "doctor",
			args:        []string{"doctor"},
			description: "validate remote host, KVM, toolchain, and image paths",
		},
		{
			key:         "setup",
			title:       "setup",
			args:        []string{"setup"},
			description: "install remote deps and bootstrap Firecracker assets",
		},
		{
			key:           "sync",
			title:         "sync",
			args:          []string{"sync"},
			description:   "sync local src-go to remote host",
			refreshStatus: true,
		},
		{
			key:           "up",
			title:         "up",
			args:          []string{"up"},
			description:   "start remote nanoclawd/sessiond/vm-supervisor",
			refreshStatus: true,
		},
		{
			key:         "status",
			title:       "status",
			args:        []string{"status"},
			description: "fetch remote process and health state",
		},
		{
			key:         "smoke",
			title:       "smoke",
			args:        []string{"smoke"},
			description: "run remote Telegram runtime and sandbox lifecycle smoke suite",
		},
		{
			key:         "task_echo",
			title:       "task (telegram-runtime)",
			args:        []string{"task", "telegram-agent --runtime microvm --source devctl"},
			description: "submit one remote Telegram runtime task request",
		},
		{
			key:         "logs_all",
			title:       "logs (all)",
			args:        []string{"logs", "all"},
			description: "tail remote logs for all services",
		},
		{
			key:         "logs_nanoclawd",
			title:       "logs (nanoclawd)",
			args:        []string{"logs", "nanoclawd"},
			description: "tail remote nanoclawd logs",
		},
		{
			key:         "logs_sessiond",
			title:       "logs (sessiond)",
			args:        []string{"logs", "sessiond"},
			description: "tail remote sessiond logs",
		},
		{
			key:         "logs_supervisor",
			title:       "logs (vm-supervisor)",
			args:        []string{"logs", "vm-supervisor"},
			description: "tail remote vm-supervisor logs",
		},
		{
			key:         "test",
			title:       "test (go test ./...)",
			args:        []string{"test"},
			description: "run remote unit tests across src-go",
		},
		{
			key:           "down",
			title:         "down",
			args:          []string{"down"},
			description:   "stop remote services",
			refreshStatus: true,
		},
		{
			key:           "restart",
			title:         "restart",
			args:          []string{"restart"},
			description:   "restart remote services",
			refreshStatus: true,
		},
	}
}

func parseStatusOutput(output string) map[string]remoteServiceState {
	parsed := make(map[string]remoteServiceState, 3)
	for _, raw := range strings.Split(output, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		serviceName := fields[0]
		if !isTrackedService(serviceName) {
			continue
		}
		state := parsed[serviceName]
		for _, field := range fields[1:] {
			pair := strings.SplitN(field, "=", 2)
			if len(pair) != 2 {
				continue
			}
			switch pair[0] {
			case "process":
				state.process = pair[1]
			case "health":
				state.health = pair[1]
			}
		}
		parsed[serviceName] = state
	}
	return parsed
}

func isTrackedService(name string) bool {
	return name == "nanoclawd" || name == "sessiond" || name == "vm-supervisor"
}

func tailLines(value string, limit int) []string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	lines := strings.Split(trimmed, "\n")
	if limit <= 0 || len(lines) <= limit {
		return lines
	}
	return lines[len(lines)-limit:]
}

func loadRemoteConfig(workdir string) remoteConfig {
	envFile := strings.TrimSpace(os.Getenv("NANOCLAW_GO_ENV_FILE"))
	if envFile == "" {
		envFile = filepath.Join(workdir, ".env")
	}
	fileValues := parseEnvFile(envFile)
	envOrFile := func(key string) string {
		if fromEnv := strings.TrimSpace(os.Getenv(key)); fromEnv != "" {
			return fromEnv
		}
		return strings.TrimSpace(fileValues[key])
	}
	envOrDefault := func(key string, fallback string) string {
		value := envOrFile(key)
		if value == "" {
			return fallback
		}
		return value
	}

	remoteWorkdir := envOrDefault("NANOCLAW_REMOTE_WORKDIR", "/root/nanoclaw-buffalo")
	remoteSrcGoDir := envOrFile("NANOCLAW_REMOTE_SRC_GO_DIR")
	if remoteSrcGoDir == "" && remoteWorkdir != "" {
		remoteSrcGoDir = path.Join(remoteWorkdir, "src-go")
	}

	return remoteConfig{
		envFile:        envFile,
		host:           envOrFile("NANOCLAW_REMOTE_HOST"),
		remoteWorkdir:  remoteWorkdir,
		remoteSrcGoDir: remoteSrcGoDir,
		firecrackerBin: envOrDefault("NANOCLAW_REMOTE_FIRECRACKER_BIN", "/opt/firecracker/bin/firecracker"),
		kernelImage:    envOrDefault("NANOCLAW_REMOTE_KERNEL_IMAGE", "/opt/firecracker/images/vmlinux.bin"),
		rootfsImage:    envOrDefault("NANOCLAW_REMOTE_ROOTFS_IMAGE", "/opt/firecracker/images/bionic.rootfs.ext4"),
		netMode:        envOrDefault("NANOCLAW_REMOTE_VM_NET_MODE", "none"),
	}
}

func parseEnvFile(filePath string) map[string]string {
	values := make(map[string]string)
	data, err := os.ReadFile(filePath)
	if err != nil {
		return values
	}

	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		pairIndex := strings.Index(line, "=")
		if pairIndex <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:pairIndex])
		value := strings.TrimSpace(line[pairIndex+1:])
		value = strings.Trim(value, "\"'")
		values[key] = value
	}

	return values
}

func displayOrUnset(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "(unset)"
	}
	return trimmed
}

func formatDuration(value time.Duration) string {
	if value < time.Second {
		return fmt.Sprintf("%dms", value.Milliseconds())
	}
	seconds := int(value.Seconds())
	if seconds < 60 {
		return fmt.Sprintf("%ds", seconds)
	}
	minutes := seconds / 60
	if minutes < 60 {
		return fmt.Sprintf("%dm%ds", minutes, seconds%60)
	}
	return fmt.Sprintf("%dh%dm", minutes/60, minutes%60)
}
