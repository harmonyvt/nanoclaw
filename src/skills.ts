/**
 * Skill loading utilities for the host process.
 * Skills are stored as JSON files in groups/{folder}/skills/{name}.json.
 */

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import type { Skill } from './types.js';
import { logger } from './logger.js';

function skillsDir(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'skills');
}

/** Load all valid skills for a group. Skips corrupt files. */
export function loadSkillsForGroup(groupFolder: string): Skill[] {
  const dir = skillsDir(groupFolder);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const skills: Skill[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(dir, file), 'utf-8'),
      );
      if (data.name && data.description && data.instructions) {
        skills.push(data as Skill);
      }
    } catch (err) {
      logger.warn(
        { module: 'skills', file, err },
        'Skipping corrupt skill file',
      );
    }
  }

  return skills;
}

/** Load a single skill by name. Returns null if not found or corrupt. */
export function getSkill(
  groupFolder: string,
  name: string,
): Skill | null {
  const filePath = path.join(skillsDir(groupFolder), `${name}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (data.name && data.description && data.instructions) {
      return data as Skill;
    }
    return null;
  } catch {
    return null;
  }
}

/** Delete a skill file. Returns true if deleted, false if not found. */
export function deleteSkill(
  groupFolder: string,
  name: string,
): boolean {
  const filePath = path.join(skillsDir(groupFolder), `${name}.json`);
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Get skill commands formatted for Telegram setMyCommands. */
export function getSkillCommandsForGroup(
  groupFolder: string,
): Array<{ command: string; description: string }> {
  const skills = loadSkillsForGroup(groupFolder);
  return skills.map((s) => ({
    command: s.name,
    description: s.description.slice(0, 256),
  }));
}

/** Get all skill names for a group (fast, no full parse). */
export function getSkillNames(groupFolder: string): Set<string> {
  const dir = skillsDir(groupFolder);
  if (!fs.existsSync(dir)) return new Set();

  return new Set(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, '')),
  );
}
