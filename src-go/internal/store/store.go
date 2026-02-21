package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

var ErrNotFound = errors.New("not found")

const (
	defaultMaxPersistedEvents = 2000
	eventRetentionEnvKey      = "NANOCLAW_GO_EVENT_RETENTION"
)

type SandboxRecord struct {
	Spec   contracts.SandboxSpec   `json:"spec"`
	Status contracts.SandboxStatus `json:"status"`
}

type persistedState struct {
	Sandboxes map[string]SandboxRecord           `json:"sandboxes"`
	Tasks     map[string]contracts.TaskRunResult `json:"tasks"`
	Sessions  map[string]contracts.SessionInfo   `json:"sessions"`
	Events    []contracts.Event                  `json:"events"`
}

type MemoryStore struct {
	mu sync.RWMutex

	stateFile string
	maxEvents int
	sandboxes map[string]SandboxRecord
	tasks     map[string]contracts.TaskRunResult
	sessions  map[string]contracts.SessionInfo
	events    []contracts.Event
}

func NewMemoryStore(stateFile string) (*MemoryStore, error) {
	st := &MemoryStore{
		stateFile: stateFile,
		maxEvents: eventRetentionLimit(),
		sandboxes: map[string]SandboxRecord{},
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
	s.sandboxes[spec.SandboxID] = SandboxRecord{Spec: spec, Status: status}
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

func (s *MemoryStore) ListSandboxRecords() []SandboxRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()

	ids := make([]string, 0, len(s.sandboxes))
	for id := range s.sandboxes {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	items := make([]SandboxRecord, 0, len(ids))
	for _, id := range ids {
		items = append(items, s.sandboxes[id])
	}
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

func (s *MemoryStore) ListTasks() []contracts.TaskRunResult {
	s.mu.RLock()
	defer s.mu.RUnlock()

	items := make([]contracts.TaskRunResult, 0, len(s.tasks))
	for _, task := range s.tasks {
		items = append(items, task)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CompletedAt.Equal(items[j].CompletedAt) {
			return items[i].TaskID < items[j].TaskID
		}
		return items[i].CompletedAt.After(items[j].CompletedAt)
	})
	return items
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

func (s *MemoryStore) ListSessions() []contracts.SessionInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	items := make([]contracts.SessionInfo, 0, len(s.sessions))
	for _, session := range s.sessions {
		items = append(items, session)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].SessionID < items[j].SessionID
		}
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
	return items
}

func (s *MemoryStore) SaveEvent(event contracts.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	s.events = trimEvents(s.events, s.maxEvents)
	return s.persistLocked()
}

func (s *MemoryStore) ListEvents(limit int) []contracts.Event {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if limit < 1 || limit > len(s.events) {
		limit = len(s.events)
	}
	start := len(s.events) - limit
	if start < 0 {
		start = 0
	}
	items := make([]contracts.Event, len(s.events[start:]))
	copy(items, s.events[start:])
	sort.Slice(items, func(i, j int) bool {
		if items[i].Timestamp.Equal(items[j].Timestamp) {
			return items[i].Type < items[j].Type
		}
		return items[i].Timestamp.Before(items[j].Timestamp)
	})
	return items
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
		s.events = trimEvents(parsed.Events, s.maxEvents)
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

func eventRetentionLimit() int {
	raw := strings.TrimSpace(os.Getenv(eventRetentionEnvKey))
	if raw == "" {
		return defaultMaxPersistedEvents
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 {
		return defaultMaxPersistedEvents
	}
	return limit
}

func trimEvents(events []contracts.Event, maxEvents int) []contracts.Event {
	if maxEvents < 1 || len(events) <= maxEvents {
		return events
	}
	trimmed := make([]contracts.Event, maxEvents)
	copy(trimmed, events[len(events)-maxEvents:])
	return trimmed
}
