package devcli

import (
	"fmt"
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

type Model struct {
	services []*Service
	cursor   int
	width    int
	height   int
	status   string
}

func NewModel(workdir string) *Model {
	specs := []ServiceSpec{
		{
			Name:        "nanoclawd",
			PackagePath: "./cmd/nanoclawd",
			Env: map[string]string{
				"NANOCLAW_GO_SIMULATED_VM": "true",
			},
		},
		{
			Name:        "sessiond",
			PackagePath: "./cmd/sessiond",
		},
		{
			Name:        "vm-supervisor",
			PackagePath: "./cmd/vm-supervisor",
			Env: map[string]string{
				"NANOCLAW_GO_SIMULATED_VM": "true",
			},
		},
	}

	services := make([]*Service, 0, len(specs))
	for _, spec := range specs {
		services = append(services, NewService(workdir, spec))
	}

	model := &Model{
		services: services,
		status:   "Press s to start selected service.",
	}
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

	for idx, service := range m.services {
		pointer := "  "
		if idx == m.cursor {
			pointer = "> "
		}
		state := service.State()
		statusStyle := stateStyle(state)
		uptime := formatDuration(service.Uptime())
		row := fmt.Sprintf("%s%-14s %-10s uptime=%-8s %s", pointer, service.Spec().Name, statusStyle.Render(string(state)), uptime, service.Spec().PackagePath)
		builder.WriteString(row)
		builder.WriteString("\n")
	}

	builder.WriteString("\n")
	selected := m.selectedService()
	if selected != nil {
		logTitle := lipgloss.NewStyle().Bold(true).Render("Logs: " + selected.Spec().Name)
		builder.WriteString(logTitle)
		builder.WriteString("\n")
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
	builder.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("245")).Render("keys: up/down select | s start | t stop | r restart | a start all | z stop all | q quit"))
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
