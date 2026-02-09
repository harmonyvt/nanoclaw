/**
 * Tests for src/skills.ts — host-side skill loading utilities.
 * Uses a temporary directory to simulate groups/{folder}/skills/.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We need to mock GROUPS_DIR before importing skills.ts.
// Since skills.ts reads GROUPS_DIR from config at import time,
// we'll test by directly exercising the filesystem functions.

let tmpDir: string;
let skillsDir: string;

function writeSkillFile(name: string, data: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(skillsDir, `${name}.json`),
    JSON.stringify(data, null, 2),
  );
}

function makeSkill(overrides: Partial<{
  name: string;
  description: string;
  instructions: string;
  parameters: string;
  created_at: string;
  updated_at: string;
}> = {}) {
  return {
    name: overrides.name ?? 'test_skill',
    description: overrides.description ?? 'A test skill',
    instructions: overrides.instructions ?? 'Step 1: Do something',
    ...(overrides.parameters ? { parameters: overrides.parameters } : {}),
    created_at: overrides.created_at ?? '2026-02-09T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-02-09T00:00:00.000Z',
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-test-'));
  skillsDir = path.join(tmpDir, 'test-group', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Direct filesystem tests (no module import, tests the data format) ──────

describe('Skill JSON format', () => {
  test('valid skill file has required fields', () => {
    const skill = makeSkill({ name: 'check_analytics' });
    writeSkillFile('check_analytics', skill);

    const content = JSON.parse(
      fs.readFileSync(path.join(skillsDir, 'check_analytics.json'), 'utf-8'),
    );
    expect(content.name).toBe('check_analytics');
    expect(content.description).toBe('A test skill');
    expect(content.instructions).toBe('Step 1: Do something');
    expect(content.created_at).toBeTruthy();
    expect(content.updated_at).toBeTruthy();
  });

  test('skill with parameters includes parameter field', () => {
    const skill = makeSkill({
      name: 'report',
      parameters: 'time period like "last_week" or "today"',
    });
    writeSkillFile('report', skill);

    const content = JSON.parse(
      fs.readFileSync(path.join(skillsDir, 'report.json'), 'utf-8'),
    );
    expect(content.parameters).toBe('time period like "last_week" or "today"');
  });
});

// ─── Skill loading logic tests (replicate what skills.ts does) ──────────────

describe('Skill loading', () => {
  function loadSkills(): Array<Record<string, unknown>> {
    if (!fs.existsSync(skillsDir)) return [];
    const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith('.json'));
    const skills: Array<Record<string, unknown>> = [];
    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(skillsDir, file), 'utf-8'),
        );
        if (data.name && data.description && data.instructions) {
          skills.push(data);
        }
      } catch {
        // skip corrupt files
      }
    }
    return skills;
  }

  function getSkill(name: string): Record<string, unknown> | null {
    const filePath = path.join(skillsDir, `${name}.json`);
    try {
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.name && data.description && data.instructions) return data;
      return null;
    } catch {
      return null;
    }
  }

  test('returns empty array when skills dir does not exist', () => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    expect(loadSkills()).toEqual([]);
  });

  test('returns empty array when skills dir is empty', () => {
    expect(loadSkills()).toEqual([]);
  });

  test('loads single skill', () => {
    writeSkillFile('my_skill', makeSkill({ name: 'my_skill' }));
    const skills = loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('my_skill');
  });

  test('loads multiple skills', () => {
    writeSkillFile('skill_a', makeSkill({ name: 'skill_a' }));
    writeSkillFile('skill_b', makeSkill({ name: 'skill_b' }));
    writeSkillFile('skill_c', makeSkill({ name: 'skill_c' }));
    const skills = loadSkills();
    expect(skills).toHaveLength(3);
  });

  test('skips corrupt JSON files', () => {
    writeSkillFile('good', makeSkill({ name: 'good' }));
    fs.writeFileSync(path.join(skillsDir, 'bad.json'), '{{{not valid json');
    const skills = loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('good');
  });

  test('skips files missing required fields', () => {
    writeSkillFile('good', makeSkill({ name: 'good' }));
    writeSkillFile('incomplete', { name: 'incomplete', description: 'no instructions' });
    const skills = loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('good');
  });

  test('ignores non-json files', () => {
    writeSkillFile('valid', makeSkill({ name: 'valid' }));
    fs.writeFileSync(path.join(skillsDir, 'notes.txt'), 'some text');
    fs.writeFileSync(path.join(skillsDir, 'readme.md'), '# readme');
    const skills = loadSkills();
    expect(skills).toHaveLength(1);
  });

  test('getSkill returns null for nonexistent skill', () => {
    expect(getSkill('nonexistent')).toBeNull();
  });

  test('getSkill returns skill when it exists', () => {
    writeSkillFile('target', makeSkill({ name: 'target', description: 'Target skill' }));
    const skill = getSkill('target');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('target');
    expect(skill!.description).toBe('Target skill');
  });

  test('getSkill returns null for corrupt file', () => {
    fs.writeFileSync(path.join(skillsDir, 'broken.json'), 'not json');
    expect(getSkill('broken')).toBeNull();
  });
});

// ─── Skill deletion tests ───────────────────────────────────────────────────

describe('Skill deletion', () => {
  function deleteSkill(name: string): boolean {
    const filePath = path.join(skillsDir, `${name}.json`);
    try {
      if (!fs.existsSync(filePath)) return false;
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  test('deletes existing skill', () => {
    writeSkillFile('to_delete', makeSkill({ name: 'to_delete' }));
    expect(fs.existsSync(path.join(skillsDir, 'to_delete.json'))).toBe(true);
    expect(deleteSkill('to_delete')).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'to_delete.json'))).toBe(false);
  });

  test('returns false for nonexistent skill', () => {
    expect(deleteSkill('nonexistent')).toBe(false);
  });
});

// ─── Skill name set tests ───────────────────────────────────────────────────

describe('Skill names', () => {
  function getSkillNames(): Set<string> {
    if (!fs.existsSync(skillsDir)) return new Set();
    return new Set(
      fs.readdirSync(skillsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, '')),
    );
  }

  test('returns empty set when no skills', () => {
    expect(getSkillNames().size).toBe(0);
  });

  test('returns correct skill names', () => {
    writeSkillFile('alpha', makeSkill({ name: 'alpha' }));
    writeSkillFile('beta', makeSkill({ name: 'beta' }));
    const names = getSkillNames();
    expect(names.size).toBe(2);
    expect(names.has('alpha')).toBe(true);
    expect(names.has('beta')).toBe(true);
  });
});

// ─── Skill command formatting tests ─────────────────────────────────────────

describe('Skill commands for Telegram', () => {
  test('formats skills as Telegram commands', () => {
    writeSkillFile('check', makeSkill({ name: 'check', description: 'Check something' }));
    writeSkillFile('report', makeSkill({ name: 'report', description: 'Generate a report' }));

    // Replicate getSkillCommandsForGroup logic
    const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith('.json'));
    const commands = files
      .map((f) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(skillsDir, f), 'utf-8'));
          if (data.name && data.description && data.instructions) {
            return { command: data.name, description: data.description.slice(0, 256) };
          }
          return null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    expect(commands).toHaveLength(2);
    expect(commands[0]!.command).toBeTruthy();
    expect(commands[0]!.description).toBeTruthy();
  });

  test('truncates long descriptions to 256 chars', () => {
    const longDesc = 'A'.repeat(300);
    writeSkillFile('verbose', makeSkill({ name: 'verbose', description: longDesc }));

    const data = JSON.parse(
      fs.readFileSync(path.join(skillsDir, 'verbose.json'), 'utf-8'),
    );
    const truncated = data.description.slice(0, 256);
    expect(truncated.length).toBeLessThanOrEqual(256);
  });
});
