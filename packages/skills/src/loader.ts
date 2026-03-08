import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SkillEntry, SkillMetadata } from './types.js';

interface FrontmatterResult {
  data: Record<string, unknown>;
  content: string;
}

function parseFrontmatter(raw: string): FrontmatterResult {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { data: {}, content: raw };
  }

  // Simple YAML-like parser for frontmatter (avoids gray-matter dep for now)
  const yamlStr = match[1];
  const content = match[2];

  try {
    // Use dynamic import for yaml since we already have it via config
    const data = parseSimpleYaml(yamlStr);
    return { data, content };
  } catch {
    return { data: {}, content: raw };
  }
}

function parseSimpleYaml(yamlStr: string): Record<string, unknown> {
  // Minimal YAML parser for skill frontmatter
  // Only handles top-level key: value pairs and nested objects
  const result: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');

  let currentKey = '';
  let currentIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^(\s*)(\w+):\s*(.*)/);
    if (match) {
      const indent = match[1].length;
      const key = match[2];
      const value = match[3].trim();

      if (indent === 0) {
        currentKey = key;
        currentIndent = 0;
        if (value && !value.startsWith('"') || value === '') {
          result[key] = value || undefined;
        } else if (value.startsWith('"')) {
          result[key] = value.replace(/^"|"$/g, '');
        }
      }
    }
  }

  // For complex frontmatter, fall back to JSON if embedded
  try {
    const jsonMatch = yamlStr.match(/metadata:\s*\n\s*(\{[\s\S]*\})/);
    if (jsonMatch) {
      result.metadata = JSON.parse(jsonMatch[1]);
    }
  } catch {
    // ignore
  }

  return result;
}

function hasBinary(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function loadSkillsFromDirectory(dir: string): SkillEntry[] {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const skills: SkillEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillFile = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    try {
      const raw = readFileSync(skillFile, 'utf-8');
      const { data, content } = parseFrontmatter(raw);

      const skill: SkillEntry = {
        name: (data.name as string) ?? entry.name,
        description: (data.description as string) ?? '',
        content,
        metadata: data.metadata as SkillMetadata | undefined,
      };

      skills.push(skill);
    } catch {
      // Skip malformed skills
    }
  }

  return skills;
}

export function loadSkills(directories: string[]): SkillEntry[] {
  const allSkills: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const dir of directories) {
    const resolved = resolve(dir);
    const skills = loadSkillsFromDirectory(resolved);
    for (const skill of skills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        allSkills.push(skill);
      }
    }
  }

  return allSkills;
}

export function filterEligibleSkills(skills: SkillEntry[]): SkillEntry[] {
  return skills.filter((skill) => {
    const requires = skill.metadata?.cereworker?.requires;
    if (!requires) return true;

    if (requires.bins) {
      return requires.bins.every(hasBinary);
    }

    return true;
  });
}
