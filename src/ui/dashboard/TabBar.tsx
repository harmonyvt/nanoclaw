const TABS = ['logs', 'containers', 'tasks', 'threads', 'files', 'takeover', 'trajectory'] as const;

const TAB_LABELS: Record<string, string> = {
  logs: 'Logs',
  containers: 'Containers',
  tasks: 'Tasks',
  threads: 'Threads',
  files: 'Files',
  takeover: 'Takeover',
  trajectory: 'Trajectory',
};

interface TabBarProps {
  active: string;
  onChange: (tab: string) => void;
}

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <div class="tabs">
      {TABS.map((tab) => (
        <div
          key={tab}
          class={`tab${tab === active ? ' active' : ''}`}
          onClick={() => onChange(tab)}
        >
          {TAB_LABELS[tab]}
        </div>
      ))}
    </div>
  );
}
