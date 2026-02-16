/**
 * Accessibility tree summarizer for browse_snapshot results.
 */

const SNAPSHOT_LABEL_FIELDS = [
  'title', 'label', 'name', 'text', 'description',
  'value', 'content', 'aria_label', 'ariaLabel', 'placeholder',
];

const SNAPSHOT_ROLE_FIELDS = ['role', 'class', 'type', 'controlType', 'control_type'];

const SNAPSHOT_MAX_INTERACTIVE = 30;
const SNAPSHOT_MAX_CONTENT = 15;
const SNAPSHOT_MAX_RAW_CHARS = 10_000;

interface SnapshotElement {
  label: string;
  role: string;
  interactive: boolean;
}

function coerceRecord(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* not JSON */ }
  }
  return null;
}

function collectSnapshotNodes(
  node: Record<string, unknown>,
  output: Record<string, unknown>[],
  depth = 0,
): void {
  if (depth > 200) return;
  output.push(node);
  for (const key of ['children', 'nodes', 'elements', 'items']) {
    const raw = node[key];
    if (!Array.isArray(raw)) continue;
    for (const child of raw) {
      const rec = coerceRecord(child);
      if (rec) collectSnapshotNodes(rec, output, depth + 1);
    }
  }
}

function snapshotNodeIsInteractive(node: Record<string, unknown>, role: string): boolean {
  if (node.clickable === true || node.interactive === true || node.interactivity === true) {
    return true;
  }
  return /button|input|entry|link|checkbox|textbox|tab|menuitem|combobox|search/i.test(role);
}

/**
 * Convert a raw accessibility tree (JSON or string) into a structured summary
 * listing interactive and content elements.
 */
export function summarizeAccessibilityTree(raw: string): string {
  const record = coerceRecord(raw);
  if (!record) {
    if (raw.length > SNAPSHOT_MAX_RAW_CHARS) {
      return raw.slice(0, SNAPSHOT_MAX_RAW_CHARS) + '\n\n[Snapshot truncated]';
    }
    return raw;
  }

  const root = coerceRecord(record.tree) || record;

  const nodes: Record<string, unknown>[] = [];
  collectSnapshotNodes(root, nodes);

  const elements: SnapshotElement[] = [];
  for (const node of nodes) {
    let role = '';
    for (const key of SNAPSHOT_ROLE_FIELDS) {
      const v = node[key];
      if (typeof v === 'string' && v.trim()) { role = v.trim(); break; }
    }

    let label = '';
    for (const key of SNAPSHOT_LABEL_FIELDS) {
      const v = node[key];
      if (typeof v === 'string' && v.trim()) { label = v.trim(); break; }
    }
    if (!label) continue;

    const interactive = snapshotNodeIsInteractive(node, role);
    elements.push({ label: label.slice(0, 80), role: role || 'element', interactive });
  }

  const interactiveEls = elements.filter(e => e.interactive);
  const contentEls = elements.filter(e => !e.interactive);

  const lines: string[] = [];
  lines.push(`Page snapshot (${elements.length} elements, ${interactiveEls.length} interactive):`);

  if (interactiveEls.length > 0) {
    lines.push('\nInteractive elements:');
    for (const [i, el] of interactiveEls.slice(0, SNAPSHOT_MAX_INTERACTIVE).entries()) {
      lines.push(`${i + 1}. "${el.label}" [${el.role}]`);
    }
    if (interactiveEls.length > SNAPSHOT_MAX_INTERACTIVE) {
      lines.push(`   ... and ${interactiveEls.length - SNAPSHOT_MAX_INTERACTIVE} more`);
    }
  }

  if (contentEls.length > 0) {
    lines.push('\nContent elements:');
    for (const [i, el] of contentEls.slice(0, SNAPSHOT_MAX_CONTENT).entries()) {
      lines.push(`${i + 1}. "${el.label}" [${el.role}]`);
    }
    if (contentEls.length > SNAPSHOT_MAX_CONTENT) {
      lines.push(`   ... and ${contentEls.length - SNAPSHOT_MAX_CONTENT} more`);
    }
  }

  if (elements.length === 0) {
    lines.push('\nNo labeled elements found in snapshot.');
  }

  return lines.join('\n');
}
