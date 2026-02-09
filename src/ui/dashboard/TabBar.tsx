const TABS = ['logs', 'containers', 'tasks', 'files', 'takeover', 'follow'] as const;

const TAB_LABELS: Record<string, string> = {
  logs: 'Logs',
  containers: 'Containers',
  tasks: 'Tasks',
  files: 'Files',
  takeover: 'Takeover',
  follow: 'Follow',
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
