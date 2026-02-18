package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

var ErrNotFound = errors.New("not found")

type sandboxRecord struct {
	Spec   contracts.SandboxSpec   `json:"spec"`
	Status contracts.SandboxStatus `json:"status"`
}

type persistedState struct {
	Sandboxes map[string]sandboxRecord           `json:"sandboxes"`
	Tasks     map[string]contracts.TaskRunResult `json:"tasks"`
	Sessions  map[string]contracts.SessionInfo   `json:"sessions"`
	Events    []contracts.Event                  `json:"events"`
}

type MemoryStore struct {
	mu sync.RWMutex

	stateFile string
	sandboxes map[string]sandboxRecord
	tasks     map[string]contracts.TaskRunResult
	sessions  map[string]contracts.SessionInfo
	events    []contracts.Event
}

func NewMemoryStore(stateFile string) (*MemoryStore, error) {
	st := &MemoryStore{
		stateFile: stateFile,
		sandboxes: map[string]sandboxRecord{},
		tasks:     map[string]contracts.TaskRunResult{},
		sessions:  map[string]contracts.SessionInfo{},
		events:    []contracts.Event{},
	}
	if err := st.loadFromDisk(); err != nil {
		return nil, err
	}
	return st, nil
}

func (s *MemoryStore) UpsertSandbox(spec contracts.SandboxSpec, status contracts.SandboxStatus) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sandboxes[spec.SandboxID] = sandboxRecord{Spec: spec, Status: status}
	return s.persistLocked()
}

func (s *MemoryStore) GetSandbox(id string) (contracts.SandboxSpec, contracts.SandboxStatus, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.sandboxes[id]
	if !ok {
		return contracts.SandboxSpec{}, contracts.SandboxStatus{}, ErrNotFound
	}
	return record.Spec, record.Status, nil
}

func (s *MemoryStore) UpdateSandboxStatus(status contracts.SandboxStatus) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.sandboxes[status.SandboxID]
	if !ok {
		return ErrNotFound
	}
	record.Status = status
	s.sandboxes[status.SandboxID] = record
	return s.persistLocked()
}

func (s *MemoryStore) ListSandboxes() []contracts.SandboxStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]contracts.SandboxStatus, 0, len(s.sandboxes))
	for _, record := range s.sandboxes {
		items = append(items, record.Status)
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].SandboxID < items[j].SandboxID
	})
	return items
}

func (s *MemoryStore) SaveTask(result contracts.TaskRunResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tasks[result.TaskID] = result
	return s.persistLocked()
}

func (s *MemoryStore) GetTask(taskID string) (contracts.TaskRunResult, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result, ok := s.tasks[taskID]
	if !ok {
		return contracts.TaskRunResult{}, ErrNotFound
	}
	return result, nil
}

func (s *MemoryStore) SaveSession(session contracts.SessionInfo) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[session.SessionID] = session
	return s.persistLocked()
}

func (s *MemoryStore) GetSession(sessionID string) (contracts.SessionInfo, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	session, ok := s.sessions[sessionID]
	if !ok {
		return contracts.SessionInfo{}, ErrNotFound
	}
	return session, nil
}

func (s *MemoryStore) SaveEvent(event contracts.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	return s.persistLocked()
}

func (s *MemoryStore) loadFromDisk() error {
	if s.stateFile == "" {
		return nil
	}

	raw, err := os.ReadFile(s.stateFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read state file: %w", err)
	}
	if len(raw) == 0 {
		return nil
	}

	var parsed persistedState
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return fmt.Errorf("decode state file: %w", err)
	}

	if parsed.Sandboxes != nil {
		s.sandboxes = parsed.Sandboxes
	}
	if parsed.Tasks != nil {
		s.tasks = parsed.Tasks
	}
	if parsed.Sessions != nil {
		s.sessions = parsed.Sessions
	}
	if parsed.Events != nil {
		s.events = parsed.Events
	}
	return nil
}

func (s *MemoryStore) persistLocked() error {
	if s.stateFile == "" {
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(s.stateFile), 0o755); err != nil {
		return fmt.Errorf("mkdir state dir: %w", err)
	}

	payload := persistedState{
		Sandboxes: s.sandboxes,
		Tasks:     s.tasks,
		Sessions:  s.sessions,
		Events:    s.events,
	}
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("encode state file: %w", err)
	}

	tmp := s.stateFile + ".tmp"
	if err := os.WriteFile(tmp, encoded, 0o644); err != nil {
		return fmt.Errorf("write state temp file: %w", err)
	}
	if err := os.Rename(tmp, s.stateFile); err != nil {
		return fmt.Errorf("replace state file: %w", err)
	}
	return nil
}
