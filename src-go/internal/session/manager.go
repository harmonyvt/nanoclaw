package session

import (
	"fmt"
	"sync"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
	"github.com/harmony/nanoclaw/src-go/internal/store"
)

type Manager struct {
	mu     sync.Mutex
	store  *store.MemoryStore
	inputs map[string][]string
	sizes  map[string][2]int
}

func NewManager(s *store.MemoryStore) *Manager {
	return &Manager{
		store:  s,
		inputs: map[string][]string{},
		sizes:  map[string][2]int{},
	}
}

func (m *Manager) Create(req contracts.SessionCreateRequest) (contracts.SessionInfo, error) {
	now := time.Now().UTC()
	s := contracts.SessionInfo{
		SessionID:   fmt.Sprintf("sess-%d", now.UnixNano()),
		SandboxID:   req.SandboxID,
		Status:      "active",
		Command:     req.Command,
		CreatedAt:   now,
		LastInputAt: now,
	}
	if s.Command == "" {
		s.Command = "sh"
	}
	if err := m.store.SaveSession(s); err != nil {
		return contracts.SessionInfo{}, err
	}
	return s, nil
}

func (m *Manager) Input(sessionID, input string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.inputs[sessionID] = append(m.inputs[sessionID], input)
	s, err := m.store.GetSession(sessionID)
	if err != nil {
		return err
	}
	s.LastInputAt = time.Now().UTC()
	return m.store.SaveSession(s)
}

func (m *Manager) Resize(sessionID string, rows, cols int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sizes[sessionID] = [2]int{rows, cols}
	return nil
}

func (m *Manager) Terminate(sessionID string) error {
	s, err := m.store.GetSession(sessionID)
	if err != nil {
		return err
	}
	s.Status = "terminated"
	return m.store.SaveSession(s)
}
