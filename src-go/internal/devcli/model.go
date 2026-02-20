package devcli

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type opResultMsg struct {
	service string
	action  string
	err     error
}

type tickMsg time.Time

const (
	vmBackendSimulated   = "simulated"
	vmBackendFirecracker = "firecracker"
)

type vmRuntimeConfig struct {
	backend        string
	firecrackerBin string
	netMode        string
	env            map[string]string
}

type Model struct {
	services       []*Service
	cursor         int
	width          int
	height         int
	status         string
	vmBackend      string
	vmNetMode      string
	firecrackerBin string
}

func NewModel(workdir string) *Model {
	vmCfg := readVMRuntimeConfig()
	specs := []ServiceSpec{
		{
			Name:        "nanoclawd",
			PackagePath: "./cmd/nanoclawd",
			Env:         vmCfg.env,
		},
		{
			Name:        "sessiond",
			PackagePath: "./cmd/sessiond",
		},
		{
			Name:        "vm-supervisor",
			PackagePath: "./cmd/vm-supervisor",
			Env:         vmCfg.env,
		},
	}

	services := make([]*Service, 0, len(specs))
	for _, spec := range specs {
		services = append(services, NewService(workdir, spec))
	}

	model := &Model{
		services:       services,
		vmBackend:      vmCfg.backend,
		vmNetMode:      vmCfg.netMode,
		firecrackerBin: vmCfg.firecrackerBin,
		status:         "Press s to start selected service.",
	}
	model.status = model.backendStatus("ready")
	model.clampCursor()
	return model
}

func (m *Model) Init() tea.Cmd {
	return m.tickCmd()
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
			if m.cursor < len(m.services)-1 {
				m.cursor++
			}
		case "s", "enter":
			service := m.selectedService()
			if service != nil {
				return m, m.serviceCmd(service, "start", service.Start)
			}
		case "t", "x":
			service := m.selectedService()
			if service != nil {
				return m, m.serviceCmd(service, "stop", func() error {
					return service.Stop(3 * time.Second)
				})
			}
		case "r":
			service := m.selectedService()
			if service != nil {
				return m, m.serviceCmd(service, "restart", func() error {
					if err := service.Stop(3 * time.Second); err != nil {
						return err
					}
					return service.Start()
				})
			}
		case "a":
			return m, m.startAllCmd()
		case "z":
			return m, m.stopAllCmd()
		case "b":
			if err := m.toggleBackend(); err != nil {
				m.status = err.Error()
				return m, nil
			}
			m.status = m.backendStatus("backend updated")
		}
		return m, nil
	case opResultMsg:
		if msg.err != nil {
			m.status = fmt.Sprintf("%s %s failed: %v", msg.service, msg.action, msg.err)
		} else {
			m.status = fmt.Sprintf("%s %s ok", msg.service, msg.action)
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

	title := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("63")).Render("NanoClaw Go Dev CLI")
	builder.WriteString(title)
	builder.WriteString("\n")
	builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("247")).Render("Run and monitor Go services with Bubble Tea"))
	builder.WriteString("\n\n")
	builder.WriteString(m.backendSummaryLine())
	builder.WriteString("\n")
	if m.vmBackend == vmBackendFirecracker && m.firecrackerBin == "" {
		builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Render("firecracker backend selected, but NANOCLAW_GO_FIRECRACKER_BIN is empty"))
		builder.WriteString("\n")
	}
	builder.WriteString("\n")

	for idx, service := range m.services {
		spec := service.Spec()
		pointer := "  "
		if idx == m.cursor {
			pointer = "> "
		}
		state := service.State()
		statusStyle := stateStyle(state)
		uptime := formatDuration(service.Uptime())
		row := fmt.Sprintf("%s%-14s %-10s uptime=%-8s %s", pointer, spec.Name, statusStyle.Render(string(state)), uptime, spec.PackagePath)
		builder.WriteString(row)
		builder.WriteString("\n")
	}

	builder.WriteString("\n")
	selected := m.selectedService()
	if selected != nil {
		spec := selected.Spec()
		logTitle := lipgloss.NewStyle().Bold(true).Render("Logs: " + spec.Name)
		builder.WriteString(logTitle)
		builder.WriteString("\n")
		if isVMManagedService(spec.Name) {
			builder.WriteString(m.backendSummaryLine())
			builder.WriteString("\n")
		}
		logs := selected.Logs(8)
		if len(logs) == 0 {
			builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Render("(no logs yet)"))
			builder.WriteString("\n")
		} else {
			for _, line := range logs {
				builder.WriteString(line)
				builder.WriteString("\n")
			}
		}
		if lastErr := selected.LastError(); lastErr != "" {
			builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Render("last error: " + lastErr))
			builder.WriteString("\n")
		}
	}

	builder.WriteString("\n")
	builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("220")).Render(m.status))
	builder.WriteString("\n")
	builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("245")).Render("keys: up/down select | s start | t stop | r restart | b toggle vm backend | a start all | z stop all | q quit"))
	builder.WriteString("\n")

	return builder.String()
}

func (m *Model) Shutdown() {
	for _, service := range m.services {
		_ = service.Stop(2 * time.Second)
	}
}

func (m *Model) selectedService() *Service {
	if len(m.services) == 0 || m.cursor < 0 || m.cursor >= len(m.services) {
		return nil
	}
	return m.services[m.cursor]
}

func (m *Model) clampCursor() {
	if len(m.services) == 0 {
		m.cursor = 0
		return
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.cursor >= len(m.services) {
		m.cursor = len(m.services) - 1
	}
}

func (m *Model) startAllCmd() tea.Cmd {
	cmds := make([]tea.Cmd, 0, len(m.services))
	for _, service := range m.services {
		cmds = append(cmds, m.serviceCmd(service, "start", service.Start))
	}
	return tea.Batch(cmds...)
}

func (m *Model) stopAllCmd() tea.Cmd {
	cmds := make([]tea.Cmd, 0, len(m.services))
	for _, service := range m.services {
		current := service
		cmds = append(cmds, m.serviceCmd(current, "stop", func() error {
			return current.Stop(3 * time.Second)
		}))
	}
	return tea.Batch(cmds...)
}

func (m *Model) serviceCmd(service *Service, action string, fn func() error) tea.Cmd {
	return func() tea.Msg {
		err := fn()
		return opResultMsg{
			service: service.Spec().Name,
			action:  action,
			err:     err,
		}
	}
}

func (m *Model) tickCmd() tea.Cmd {
	return tea.Tick(400*time.Millisecond, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m *Model) toggleBackend() error {
	if m.anyServiceActive() {
		return fmt.Errorf("stop all services before changing VM backend")
	}
	if m.vmBackend == vmBackendFirecracker {
		m.vmBackend = vmBackendSimulated
	} else {
		m.vmBackend = vmBackendFirecracker
	}
	m.applyVMEnvToServices()
	return nil
}

func (m *Model) anyServiceActive() bool {
	for _, service := range m.services {
		switch service.State() {
		case StateRunning, StateStarting, StateStopping:
			return true
		}
	}
	return false
}

func (m *Model) applyVMEnvToServices() {
	vmEnv := buildVMEnv(m.vmBackend, m.vmNetMode, m.firecrackerBin)
	for _, service := range m.services {
		spec := service.Spec()
		if !isVMManagedService(spec.Name) {
			continue
		}
		service.SetEnv(vmEnv)
	}
}

func (m *Model) backendSummaryLine() string {
	bin := m.firecrackerBin
	if bin == "" {
		bin = "(unset)"
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color("109")).Render(
		fmt.Sprintf("vm backend=%s | net_mode=%s | firecracker_bin=%s", m.vmBackend, m.vmNetMode, bin),
	)
}

func (m *Model) backendStatus(prefix string) string {
	if m.vmBackend == vmBackendFirecracker && m.firecrackerBin == "" {
		return fmt.Sprintf("%s: backend=%s (NANOCLAW_GO_FIRECRACKER_BIN is required)", prefix, m.vmBackend)
	}
	return fmt.Sprintf("%s: backend=%s", prefix, m.vmBackend)
}

func isVMManagedService(name string) bool {
	return name == "nanoclawd" || name == "vm-supervisor"
}

func readVMRuntimeConfig() vmRuntimeConfig {
	backend := normalizeBackend(strings.TrimSpace(os.Getenv("NANOCLAW_GO_VM_BACKEND")))
	firecrackerBin := strings.TrimSpace(os.Getenv("NANOCLAW_GO_FIRECRACKER_BIN"))
	netMode := strings.TrimSpace(os.Getenv("NANOCLAW_GO_VM_NET_MODE"))
	if netMode == "" {
		netMode = "none"
	}
	if backend == "" {
		if firecrackerBin != "" || !envBool("NANOCLAW_GO_SIMULATED_VM", true) {
			backend = vmBackendFirecracker
		} else {
			backend = vmBackendSimulated
		}
	}

	return vmRuntimeConfig{
		backend:        backend,
		firecrackerBin: firecrackerBin,
		netMode:        netMode,
		env:            buildVMEnv(backend, netMode, firecrackerBin),
	}
}

func buildVMEnv(backend string, netMode string, firecrackerBin string) map[string]string {
	values := map[string]string{
		"NANOCLAW_GO_VM_BACKEND":         backend,
		"NANOCLAW_GO_SIMULATED_VM":       strconv.FormatBool(backend != vmBackendFirecracker),
		"NANOCLAW_GO_VM_NET_MODE":        netMode,
		"NANOCLAW_GO_VM_STATE_DIR":       strings.TrimSpace(os.Getenv("NANOCLAW_GO_VM_STATE_DIR")),
		"NANOCLAW_GO_VM_KERNEL_IMAGE":    strings.TrimSpace(os.Getenv("NANOCLAW_GO_VM_KERNEL_IMAGE")),
		"NANOCLAW_GO_VM_STOP_TIMEOUT_MS": strings.TrimSpace(os.Getenv("NANOCLAW_GO_VM_STOP_TIMEOUT_MS")),
	}
	if firecrackerBin != "" {
		values["NANOCLAW_GO_FIRECRACKER_BIN"] = firecrackerBin
	}
	return removeEmpty(values)
}

func removeEmpty(values map[string]string) map[string]string {
	out := make(map[string]string, len(values))
	for key, value := range values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		out[key] = value
	}
	return out
}

func normalizeBackend(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case vmBackendFirecracker:
		return vmBackendFirecracker
	case vmBackendSimulated:
		return vmBackendSimulated
	default:
		return ""
	}
}

func envBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return parsed
}

func stateStyle(state ServiceState) lipgloss.Style {
	switch state {
	case StateRunning:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	case StateFailed:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	case StateStarting, StateStopping:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	default:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	}
}

func formatDuration(value time.Duration) string {
	if value <= 0 {
		return "-"
	}
	seconds := int(value.Seconds())
	if seconds < 60 {
		return fmt.Sprintf("%ds", seconds)
	}
	minutes := seconds / 60
	if minutes < 60 {
		return fmt.Sprintf("%dm", minutes)
	}
	return fmt.Sprintf("%dh", minutes/60)
}
