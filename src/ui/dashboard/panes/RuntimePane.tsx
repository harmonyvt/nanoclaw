import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import { timeAgo, useSSE } from '../../shared/hooks.js';

interface FiberInfo {
  id: string;
  name: string;
  status: 'running' | 'suspended' | 'done';
  groupFolder: string | null;
  startedAt: number;
}

interface CoordinatorInfo {
  groupFolder: string;
  chatJid: string;
  queueLength: number;
  activeFiber: string | null;
  lastActivity: number;
}

interface SemaphoreState {
  available: number;
  max: number;
  waiting: number;
}

interface RuntimeSnapshot {
  fibers: FiberInfo[];
  coordinators: CoordinatorInfo[];
  semaphore: SemaphoreState;
  uptimeMs: number;
  timestamp: number;
}

interface RuntimeEvent {
  type: string;
  payload: unknown;
  timestamp: number;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function FiberIcon({ status }: { status: string }) {
  if (status === 'running') {
    return (
      <span class="fiber-icon fiber-running" title="Running">
        ●
      </span>
    );
  }
  if (status === 'suspended') {
    return (
      <span class="fiber-icon fiber-suspended" title="Suspended">
        ◐
      </span>
    );
  }
  return (
    <span class="fiber-icon fiber-done" title="Done">
      ○
    </span>
  );
}

function SemaphoreViz({ state }: { state: SemaphoreState }) {
  const slots = [];
  for (let i = 0; i < state.max; i++) {
    const isUsed = i >= state.available;
    slots.push(
      <div
        key={i}
        class={`semaphore-slot ${isUsed ? 'used' : 'free'}`}
        title={isUsed ? 'In use' : 'Available'}
      />,
    );
  }
  return (
    <div class="semaphore-viz">
      <div class="semaphore-slots">{slots}</div>
      <div class="semaphore-label">
        {state.available}/{state.max} available
        {state.waiting > 0 && <span class="waiting"> ({state.waiting} waiting)</span>}
      </div>
    </div>
  );
}

function FiberTree({ fibers }: { fibers: FiberInfo[] }) {
  const runningFibers = fibers.filter((f) => f.status === 'running');
  const otherFibers = fibers.filter((f) => f.status !== 'running');

  if (fibers.length === 0) {
    return <div class="empty-tree">No active fibers</div>;
  }

  return (
    <div class="fiber-tree">
      {runningFibers.map((fiber) => (
        <div key={fiber.id} class="fiber-node fiber-active">
          <FiberIcon status={fiber.status} />
          <span class="fiber-name">{fiber.name}</span>
          {fiber.groupFolder && (
            <span class="fiber-group">[{fiber.groupFolder}]</span>
          )}
          <span class="fiber-age">{timeAgo(new Date(fiber.startedAt).toISOString())}</span>
        </div>
      ))}
      {otherFibers.length > 0 && (
        <details class="fiber-completed">
          <summary>{otherFibers.length} completed</summary>
          {otherFibers.slice(0, 10).map((fiber) => (
            <div key={fiber.id} class="fiber-node">
              <FiberIcon status={fiber.status} />
              <span class="fiber-name">{fiber.name}</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function CoordinatorList({
  coordinators,
}: {
  coordinators: CoordinatorInfo[];
}) {
  if (coordinators.length === 0) {
    return <div class="empty-list">No active coordinators</div>;
  }

  return (
    <div class="coordinator-list">
      {coordinators.map((coord) => (
        <div key={coord.groupFolder} class="coordinator-card">
          <div class="coordinator-header">
            <span class="coordinator-name">{coord.groupFolder}</span>
            {coord.activeFiber && (
              <span class="coordinator-active" title="Has active container">
                ●
              </span>
            )}
          </div>
          <div class="coordinator-meta">
            <span class="queue-badge">
              {coord.queueLength} in queue
            </span>
            <span class="last-activity">{timeAgo(new Date(coord.lastActivity).toISOString())}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EventLog({ events }: { events: RuntimeEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const formatEventTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false });
  };

  const getEventLabel = (type: string) => {
    const labels: Record<string, string> = {
      fiber_spawned: '🚀 Fiber spawned',
      fiber_done: '✓ Fiber done',
      fiber_interrupted: '⚡ Fiber interrupted',
      message_queued: '📨 Message queued',
      message_processed: '✉️ Message processed',
      semaphore_acquired: '🔒 Semaphore acquired',
      semaphore_released: '🔓 Semaphore released',
      snapshot: '📸 Snapshot',
    };
    return labels[type] || type;
  };

  if (events.length === 0) {
    return <div class="empty-events">Waiting for events...</div>;
  }

  return (
    <div class="event-log" ref={scrollRef}>
      {events.map((event, i) => (
        <div key={`${event.timestamp}-${i}`} class="event-row">
          <span class="event-time">{formatEventTime(event.timestamp)}</span>
          <span class="event-type">{getEventLabel(event.type)}</span>
          <span class="event-payload">
            {JSON.stringify(event.payload).slice(0, 50)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function RuntimePane() {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [view, setView] = useState<'tree' | 'coordinators' | 'events'>('tree');

  const onSSEMessage = useCallback((eventType: string, data: unknown) => {
    if (eventType === 'snapshot') {
      setSnapshot(data as RuntimeSnapshot);
    } else if (eventType === 'event') {
      setEvents((prev) => [...prev.slice(-100), data as RuntimeEvent]);
    }
  }, []);

  const { connected } = useSSE('/api/runtime/stream', onSSEMessage);

  useEffect(() => {
    apiFetch<RuntimeSnapshot>('/api/runtime/snapshot')
      .then(setSnapshot)
      .catch(() => {});

    apiFetch<RuntimeEvent[]>('/api/runtime/events')
      .then(setEvents)
      .catch(() => {});
  }, []);

  return (
    <div class="runtime-pane">
      <div class="runtime-header">
        <div class="runtime-status">
          <span class={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
          {connected ? 'Connected' : 'Reconnecting...'}
        </div>
        {snapshot && (
          <div class="runtime-uptime">
            Uptime: {formatUptime(snapshot.uptimeMs)}
          </div>
        )}
      </div>

      {snapshot && (
        <div class="runtime-section">
          <div class="section-title">Concurrency</div>
          <SemaphoreViz state={snapshot.semaphore} />
        </div>
      )}

      <div class="runtime-tabs">
        <button
          class={`runtime-tab ${view === 'tree' ? 'active' : ''}`}
          onClick={() => setView('tree')}
        >
          Fibers
        </button>
        <button
          class={`runtime-tab ${view === 'coordinators' ? 'active' : ''}`}
          onClick={() => setView('coordinators')}
        >
          Coordinators
        </button>
        <button
          class={`runtime-tab ${view === 'events' ? 'active' : ''}`}
          onClick={() => setView('events')}
        >
          Events
        </button>
      </div>

      <div class="runtime-content">
        {view === 'tree' && snapshot && <FiberTree fibers={snapshot.fibers} />}
        {view === 'coordinators' && snapshot && (
          <CoordinatorList coordinators={snapshot.coordinators} />
        )}
        {view === 'events' && <EventLog events={events} />}
      </div>
    </div>
  );
}
