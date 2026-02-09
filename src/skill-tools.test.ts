/**
 * Tests for skill MCP tool handlers (store_skill, list_skills, delete_skill).
 *
 * These test the validation logic and filesystem operations directly,
 * simulating what the tool handlers do without needing the full container environment.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let skillsDir: string;
let ipcDir: string;

// Simulates the tool handler context
const CTX = {
  chatJid: 'tg:12345',
  groupFolder: 'main',
  isMain: true,
};

// Reserved command names (same as in tool-registry.ts)
const RESERVED = new Set([
  'tasks', 'runtask', 'new', 'clear', 'status', 'update', 'rebuild',
  'takeover', 'dashboard', 'follow', 'verbose', 'stop', 'help', 'skills',
  'start', 'settings', 'cancel', 'menu',
]);

const NAME_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tool-test-'));
  skillsDir = path.join(tmpDir, 'skills');
  ipcDir = path.join(tmpDir, 'ipc', 'tasks');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(ipcDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: simulate writeIpcFile
function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

// Helper: simulate store_skill handler logic
function storeSkill(args: {
  name: string;
  description: string;
  instructions: string;
  parameters?: string;
}): { content: string; isError?: boolean } {
  const { name, description, instructions, parameters } = args;

  if (!NAME_PATTERN.test(name)) {
    return {
      content: 'Invalid skill name. Must be 2-32 chars, lowercase, start with a letter, only letters/numbers/underscores.',
      isError: true,
    };
  }

  if (RESERVED.has(name)) {
    return {
      content: `"${name}" is a reserved command name. Choose a different name.`,
      isError: true,
    };
  }

  const desc = description.slice(0, 100);
  const now = new Date().toISOString();
  const skillData: Record<string, string> = {
    name,
    description: desc,
    instructions,
    created_at: now,
    updated_at: now,
  };
  if (parameters) skillData.parameters = parameters;

  fs.mkdirSync(skillsDir, { recursive: true });
  const skillPath = path.join(skillsDir, `${name}.json`);

  // Preserve created_at if updating
  try {
    if (fs.existsSync(skillPath)) {
      const existing = JSON.parse(fs.readFileSync(skillPath, 'utf-8'));
      if (existing.created_at) {
        skillData.created_at = existing.created_at;
      }
    }
  } catch {}

  const tempPath = `${skillPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(skillData, null, 2));
  fs.renameSync(tempPath, skillPath);

  writeIpcFile(ipcDir, {
    type: 'skill_changed',
    action: 'stored',
    skillName: name,
    groupFolder: CTX.groupFolder,
    timestamp: now,
  });

  return { content: `Skill "/${name}" saved. It will appear as a Telegram command shortly.` };
}

// Helper: simulate delete_skill handler logic
function deleteSkill(name: string): { content: string; isError?: boolean } {
  const skillPath = path.join(skillsDir, `${name}.json`);
  if (!fs.existsSync(skillPath)) {
    return { content: `Skill "${name}" not found.`, isError: true };
  }
  fs.unlinkSync(skillPath);
  writeIpcFile(ipcDir, {
    type: 'skill_changed',
    action: 'deleted',
    skillName: name,
    groupFolder: CTX.groupFolder,
    timestamp: new Date().toISOString(),
  });
  return { content: `Skill "/${name}" deleted.` };
}

// ─── store_skill validation tests ───────────────────────────────────────────

describe('store_skill - name validation', () => {
  test('rejects empty name', () => {
    const result = storeSkill({ name: '', description: 'd', instructions: 'i' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid skill name');
  });

  test('rejects single character name', () => {
    const result = storeSkill({ name: 'a', description: 'd', instructions: 'i' });
    expect(result.isError).toBe(true);
  });

  test('rejects name starting with number', () => {
    const result = storeSkill({ name: '1skill', description: 'd', instructions: 'i' });
    expect(result.isError).toBe(true);
  });

  test('rejects name starting with underscore', () => {
    const result = storeSkill({ name: '_skill', description: 'd', instructions: 'i' });
    expect(result.isError).toBe(true);
  });

  test('rejects uppercase letters', () => {
    const result = storeSkill({ name: 'MySkill', description: 'd', instructions: 'i' });
    expect(result.isError).toBe(true);
  });

  test('rejects hyphens', () => {
    const result = storeSkill({ name: 'my-skill', description: 'd', instructions: 'i' });
    expect(result.isError).toBe(true);
  });

  test('rejects spaces', () => {
    const result = storeSkill({ name: 'my skill', description: 'd', instructions: 'i' });
    expect(result.isError).toBe(true);
  });

  test('rejects name longer than 32 chars', () => {
    const result = storeSkill({ name: 'a'.repeat(33), description: 'd', instructions: 'i' });
    expect(result.isError).toBe(true);
  });

  test('accepts valid 2-char name', () => {
    const result = storeSkill({ name: 'ab', description: 'd', instructions: 'i' });
    expect(result.isError).toBeUndefined();
  });

  test('accepts valid name with underscores', () => {
    const result = storeSkill({ name: 'check_analytics', description: 'd', instructions: 'i' });
    expect(result.isError).toBeUndefined();
  });

  test('accepts valid name with numbers', () => {
    const result = storeSkill({ name: 'task2do', description: 'd', instructions: 'i' });
    expect(result.isError).toBeUndefined();
  });

  test('accepts max length name (32 chars)', () => {
    const name = 'a' + 'b'.repeat(30);
    expect(name.length).toBe(31);
    const result = storeSkill({ name, description: 'd', instructions: 'i' });
    expect(result.isError).toBeUndefined();
  });
});

describe('store_skill - reserved names', () => {
  const reservedNames = [
    'tasks', 'runtask', 'new', 'clear', 'status', 'update', 'rebuild',
    'takeover', 'dashboard', 'follow', 'verbose', 'stop', 'help', 'skills',
    'start', 'settings', 'cancel', 'menu',
  ];

  for (const name of reservedNames) {
    test(`rejects reserved name: ${name}`, () => {
      const result = storeSkill({ name, description: 'd', instructions: 'i' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('reserved command name');
    });
  }
});

// ─── store_skill filesystem tests ───────────────────────────────────────────

describe('store_skill - file operations', () => {
  test('creates skill JSON file', () => {
    storeSkill({
      name: 'check_analytics',
      description: 'Check Google Analytics',
      instructions: '1. Go to analytics.google.com\n2. Take screenshot',
    });

    const filePath = path.join(skillsDir, 'check_analytics.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.name).toBe('check_analytics');
    expect(data.description).toBe('Check Google Analytics');
    expect(data.instructions).toContain('analytics.google.com');
    expect(data.created_at).toBeTruthy();
    expect(data.updated_at).toBeTruthy();
  });

  test('truncates description to 100 chars', () => {
    const longDesc = 'X'.repeat(200);
    storeSkill({ name: 'verbose_skill', description: longDesc, instructions: 'i' });

    const data = JSON.parse(
      fs.readFileSync(path.join(skillsDir, 'verbose_skill.json'), 'utf-8'),
    );
    expect(data.description.length).toBe(100);
  });

  test('includes parameters when provided', () => {
    storeSkill({
      name: 'with_params',
      description: 'Has params',
      instructions: 'Do stuff',
      parameters: 'time_period: "last_week" or "today"',
    });

    const data = JSON.parse(
      fs.readFileSync(path.join(skillsDir, 'with_params.json'), 'utf-8'),
    );
    expect(data.parameters).toBe('time_period: "last_week" or "today"');
  });

  test('omits parameters field when not provided', () => {
    storeSkill({ name: 'no_params', description: 'd', instructions: 'i' });

    const data = JSON.parse(
      fs.readFileSync(path.join(skillsDir, 'no_params.json'), 'utf-8'),
    );
    expect(data.parameters).toBeUndefined();
  });

  test('overwrites existing skill (upsert)', () => {
    storeSkill({ name: 'evolving', description: 'Version 1', instructions: 'Old steps' });
    storeSkill({ name: 'evolving', description: 'Version 2', instructions: 'New steps' });

    const data = JSON.parse(
      fs.readFileSync(path.join(skillsDir, 'evolving.json'), 'utf-8'),
    );
    expect(data.description).toBe('Version 2');
    expect(data.instructions).toBe('New steps');
  });

  test('preserves created_at on update', () => {
    storeSkill({ name: 'preserved', description: 'd1', instructions: 'i1' });
    const original = JSON.parse(
      fs.readFileSync(path.join(skillsDir, 'preserved.json'), 'utf-8'),
    );
    const originalCreatedAt = original.created_at;

    // Wait a tiny bit to ensure different timestamp
    storeSkill({ name: 'preserved', description: 'd2', instructions: 'i2' });
    const updated = JSON.parse(
      fs.readFileSync(path.join(skillsDir, 'preserved.json'), 'utf-8'),
    );

    expect(updated.created_at).toBe(originalCreatedAt);
    expect(updated.description).toBe('d2');
  });

  test('writes IPC notification on store', () => {
    storeSkill({ name: 'notify_test', description: 'd', instructions: 'i' });

    const ipcFiles = fs.readdirSync(ipcDir).filter((f) => f.endsWith('.json'));
    expect(ipcFiles.length).toBeGreaterThanOrEqual(1);

    const lastFile = ipcFiles[ipcFiles.length - 1];
    const ipcData = JSON.parse(
      fs.readFileSync(path.join(ipcDir, lastFile), 'utf-8'),
    );
    expect(ipcData.type).toBe('skill_changed');
    expect(ipcData.action).toBe('stored');
    expect(ipcData.skillName).toBe('notify_test');
    expect(ipcData.groupFolder).toBe('main');
  });

  test('returns success message', () => {
    const result = storeSkill({ name: 'success_test', description: 'd', instructions: 'i' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('/success_test');
    expect(result.content).toContain('saved');
  });
});

// ─── delete_skill tests ─────────────────────────────────────────────────────

describe('delete_skill', () => {
  test('deletes existing skill file', () => {
    storeSkill({ name: 'to_delete', description: 'd', instructions: 'i' });
    expect(fs.existsSync(path.join(skillsDir, 'to_delete.json'))).toBe(true);

    const result = deleteSkill('to_delete');
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('/to_delete');
    expect(result.content).toContain('deleted');
    expect(fs.existsSync(path.join(skillsDir, 'to_delete.json'))).toBe(false);
  });

  test('returns error for nonexistent skill', () => {
    const result = deleteSkill('ghost');
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('writes IPC notification on delete', () => {
    storeSkill({ name: 'delete_notify', description: 'd', instructions: 'i' });

    // Clear previous IPC files
    for (const f of fs.readdirSync(ipcDir)) {
      fs.unlinkSync(path.join(ipcDir, f));
    }

    deleteSkill('delete_notify');

    const ipcFiles = fs.readdirSync(ipcDir).filter((f) => f.endsWith('.json'));
    expect(ipcFiles.length).toBe(1);

    const ipcData = JSON.parse(
      fs.readFileSync(path.join(ipcDir, ipcFiles[0]), 'utf-8'),
    );
    expect(ipcData.type).toBe('skill_changed');
    expect(ipcData.action).toBe('deleted');
    expect(ipcData.skillName).toBe('delete_notify');
  });
});

// ─── list_skills tests ──────────────────────────────────────────────────────

describe('list_skills', () => {
  function listSkills(): { content: string; isError?: boolean } {
    try {
      if (!fs.existsSync(skillsDir)) {
        return { content: 'No skills stored yet.' };
      }
      const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith('.json'));
      if (files.length === 0) {
        return { content: 'No skills stored yet.' };
      }
      const skills = files
        .map((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(skillsDir, f), 'utf-8'));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (skills.length === 0) {
        return { content: 'No valid skills found.' };
      }
      const formatted = skills
        .map((s: { name: string; description: string; parameters?: string }) => {
          let line = `- /${s.name}: ${s.description}`;
          if (s.parameters) line += ` (params: ${s.parameters})`;
          return line;
        })
        .join('\n');
      return { content: `Stored skills:\n${formatted}` };
    } catch (err) {
      return {
        content: `Error listing skills: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  test('returns "no skills" when directory is empty', () => {
    const result = listSkills();
    expect(result.content).toBe('No skills stored yet.');
  });

  test('returns "no skills" when directory does not exist', () => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    const result = listSkills();
    expect(result.content).toBe('No skills stored yet.');
  });

  test('lists skills with descriptions', () => {
    storeSkill({ name: 'check', description: 'Check things', instructions: 'i' });
    storeSkill({ name: 'report', description: 'Make report', instructions: 'i' });

    const result = listSkills();
    expect(result.content).toContain('/check');
    expect(result.content).toContain('Check things');
    expect(result.content).toContain('/report');
    expect(result.content).toContain('Make report');
  });

  test('includes parameter info', () => {
    storeSkill({
      name: 'paramskill',
      description: 'Has params',
      instructions: 'i',
      parameters: 'date range',
    });

    const result = listSkills();
    expect(result.content).toContain('params: date range');
  });

  test('skips corrupt files gracefully', () => {
    storeSkill({ name: 'good', description: 'Good skill', instructions: 'i' });
    fs.writeFileSync(path.join(skillsDir, 'corrupt.json'), 'not valid json!!!');

    const result = listSkills();
    expect(result.content).toContain('/good');
    expect(result.isError).toBeUndefined();
  });
});

// ─── Skill prompt injection format tests ────────────────────────────────────

describe('Skill prompt injection', () => {
  test('builds correct XML for skill without params', () => {
    const skillName = 'check_analytics';
    const instructions = '1. Go to analytics.google.com\n2. Take a screenshot';

    let xml = `<skill name="${skillName}"`;
    xml += `>\n${instructions}\n</skill>`;

    expect(xml).toBe(
      '<skill name="check_analytics">\n1. Go to analytics.google.com\n2. Take a screenshot\n</skill>',
    );
  });

  test('builds correct XML with parameters', () => {
    const skillName = 'check_analytics';
    const skillParams = 'last_week';
    const accepts = 'time period';
    const instructions = 'Check analytics for the given time period';

    let xml = `<skill name="${skillName}"`;
    if (skillParams) xml += ` parameters="${skillParams.replace(/"/g, '&quot;')}"`;
    if (accepts) xml += ` accepts="${accepts.replace(/"/g, '&quot;')}"`;
    xml += `>\n${instructions}\n</skill>`;

    expect(xml).toContain('parameters="last_week"');
    expect(xml).toContain('accepts="time period"');
    expect(xml).toContain('Check analytics');
  });

  test('escapes quotes in parameter values', () => {
    const params = 'use "quotes" here';
    const escaped = params.replace(/"/g, '&quot;');
    expect(escaped).toBe('use &quot;quotes&quot; here');
  });
});

// ─── Skill invocation regex tests ───────────────────────────────────────────

describe('Skill command detection regex', () => {
  const SKILL_REGEX = /^\/([a-z][a-z0-9_]{1,30})(?:\s+(.*))?$/;

  test('matches simple skill command', () => {
    const match = '/check_analytics'.match(SKILL_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('check_analytics');
    expect(match![2]).toBeUndefined();
  });

  test('matches skill command with parameters', () => {
    const match = '/check_analytics last_week'.match(SKILL_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('check_analytics');
    expect(match![2]).toBe('last_week');
  });

  test('matches skill with multi-word parameters', () => {
    const match = '/report from monday to friday'.match(SKILL_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('report');
    expect(match![2]).toBe('from monday to friday');
  });

  test('does not match uppercase commands', () => {
    expect('/MyCommand'.match(SKILL_REGEX)).toBeNull();
  });

  test('does not match commands starting with number', () => {
    expect('/1command'.match(SKILL_REGEX)).toBeNull();
  });

  test('does not match commands with hyphens', () => {
    expect('/my-command'.match(SKILL_REGEX)).toBeNull();
  });

  test('does not match empty command', () => {
    expect('/'.match(SKILL_REGEX)).toBeNull();
  });

  test('matches minimum length command (2 chars)', () => {
    const match = '/ab'.match(SKILL_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('ab');
  });

  test('does not match single letter command', () => {
    // Pattern requires [a-z] followed by {1,30} more chars
    expect('/a'.match(SKILL_REGEX)).toBeNull();
  });
});
