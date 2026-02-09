import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';

const LEVELS = [
  { value: '', label: 'All' },
  { value: '10', label: 'Trace' },
  { value: '20', label: 'Debug' },
  { value: '30', label: 'Info' },
  { value: '40', label: 'Warn' },
  { value: '50', label: 'Error' },
  { value: '60', label: 'Fatal' },
];

export interface LogFilterValues {
  level: string;
  search: string;
  group: string;
}

interface LogFiltersProps {
  onFiltersChange: (filters: LogFilterValues) => void;
  isSearchMode: boolean;
}

export function LogFilters({ onFiltersChange, isSearchMode }: LogFiltersProps) {
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [groups, setGroups] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Populate group dropdown from containers API
  useEffect(() => {
    apiFetch<Array<{ group_folder?: string }>>('/api/containers?limit=100')
      .then((containers) => {
        const unique = new Set<string>();
        for (const c of containers) {
          if (c.group_folder) unique.add(c.group_folder);
        }
        setGroups(Array.from(unique));
      })
      .catch(() => {
        // ignore
      });
  }, []);

  const emitFilters = useCallback(
    (newLevel: string, newSearch: string, newGroup: string) => {
      onFiltersChange({ level: newLevel, search: newSearch, group: newGroup });
    },
    [onFiltersChange],
  );

  const handleLevelChange = useCallback(
    (e: Event) => {
      const val = (e.target as HTMLSelectElement).value;
      setLevel(val);
      emitFilters(val, search, group);
    },
    [search, group, emitFilters],
  );

  const handleSearchInput = useCallback(
    (e: Event) => {
      const val = (e.target as HTMLInputElement).value;
      setSearch(val);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => {
        emitFilters(level, val, group);
      }, 300);
    },
    [level, group, emitFilters],
  );

  const handleGroupChange = useCallback(
    (e: Event) => {
      const val = (e.target as HTMLSelectElement).value;
      setGroup(val);
      emitFilters(level, search, val);
    },
    [level, search, emitFilters],
  );

  const toggleAdvanced = useCallback(() => {
    setShowAdvanced((prev) => !prev);
  }, []);

  return (
    <div class="filters">
      <div class="filter-group">
        <label>Level</label>
        <select value={level} onChange={handleLevelChange}>
          {LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div class="filter-group" style={{ flex: 1 }}>
        <input
          type="text"
          placeholder="Search logs..."
          value={search}
          onInput={handleSearchInput}
        />
      </div>
      <button class="filter-expand" onClick={toggleAdvanced}>
        {showAdvanced ? 'Less' : 'More'}
      </button>
      <div class={`filters-advanced${showAdvanced ? ' show' : ''}`}>
        <div class="filter-group">
          <label>Group</label>
          <select value={group} onChange={handleGroupChange}>
            <option value="">All</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
