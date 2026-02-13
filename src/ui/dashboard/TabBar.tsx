const TABS = ['chats', 'logs', 'containers', 'tasks', 'processes', 'files', 'takeover', 'trajectory'] as const;

const TAB_LABELS: Record<string, string> = {
  chats: 'Chats',
  logs: 'Logs',
  containers: 'Containers',
  tasks: 'Tasks',
  processes: 'Processes',
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
