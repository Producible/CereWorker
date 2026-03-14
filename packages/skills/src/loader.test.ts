import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkillsFromDirectory, loadSkills, filterEligibleSkills } from './loader.js';

describe('loadSkillsFromDirectory', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cereworker-skills-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty for nonexistent directory', () => {
    expect(loadSkillsFromDirectory('/nonexistent/path')).toEqual([]);
  });

  it('returns empty for directory with no skill subdirs', () => {
    expect(loadSkillsFromDirectory(tempDir)).toEqual([]);
  });

  it('loads a skill from SKILL.md', () => {
    const skillDir = join(tempDir, 'greet');
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: greet\ndescription: Greet the user\n---\nSay hello to the user.\n',
    );

    const skills = loadSkillsFromDirectory(tempDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('greet');
    expect(skills[0].description).toBe('Greet the user');
    expect(skills[0].content).toContain('Say hello');
  });

  it('uses directory name when frontmatter has no name', () => {
    const skillDir = join(tempDir, 'my-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: A skill\n---\nContent here\n');

    const skills = loadSkillsFromDirectory(tempDir);
    expect(skills[0].name).toBe('my-skill');
  });

  it('skips directories without SKILL.md', () => {
    mkdirSync(join(tempDir, 'empty-dir'));
    mkdirSync(join(tempDir, 'has-skill'));
    writeFileSync(join(tempDir, 'has-skill', 'SKILL.md'), '---\nname: test\n---\nContent\n');

    const skills = loadSkillsFromDirectory(tempDir);
    expect(skills).toHaveLength(1);
  });
});

describe('loadSkills', () => {
  let tempDir1: string;
  let tempDir2: string;

  beforeEach(() => {
    tempDir1 = mkdtempSync(join(tmpdir(), 'cereworker-skills1-'));
    tempDir2 = mkdtempSync(join(tmpdir(), 'cereworker-skills2-'));
  });

  afterEach(() => {
    rmSync(tempDir1, { recursive: true, force: true });
    rmSync(tempDir2, { recursive: true, force: true });
  });

  it('loads from multiple directories', () => {
    mkdirSync(join(tempDir1, 'a'));
    writeFileSync(join(tempDir1, 'a', 'SKILL.md'), '---\nname: a\n---\nA\n');
    mkdirSync(join(tempDir2, 'b'));
    writeFileSync(join(tempDir2, 'b', 'SKILL.md'), '---\nname: b\n---\nB\n');

    const skills = loadSkills([tempDir1, tempDir2]);
    expect(skills).toHaveLength(2);
  });

  it('deduplicates skills by name (first wins)', () => {
    mkdirSync(join(tempDir1, 's'));
    writeFileSync(join(tempDir1, 's', 'SKILL.md'), '---\nname: dup\ndescription: first\n---\nFirst\n');
    mkdirSync(join(tempDir2, 's'));
    writeFileSync(join(tempDir2, 's', 'SKILL.md'), '---\nname: dup\ndescription: second\n---\nSecond\n');

    const skills = loadSkills([tempDir1, tempDir2]);
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('first');
  });
});

describe('filterEligibleSkills', () => {
  it('keeps skills with no requires', () => {
    const skills = [
      { name: 'a', description: 'test', content: 'content' },
    ];
    expect(filterEligibleSkills(skills)).toHaveLength(1);
  });

  it('keeps skills when required binary exists', () => {
    const skills = [
      {
        name: 'node-skill',
        description: 'needs node',
        content: 'content',
        metadata: { cereworker: { requires: { bins: ['node'] } } },
      },
    ];
    // 'node' should exist in test environment
    expect(filterEligibleSkills(skills)).toHaveLength(1);
  });

  it('filters out skills when required binary is missing', () => {
    const skills = [
      {
        name: 'missing-skill',
        description: 'needs a nonexistent binary',
        content: 'content',
        metadata: { cereworker: { requires: { bins: ['__nonexistent_binary_xyz__'] } } },
      },
    ];
    expect(filterEligibleSkills(skills)).toHaveLength(0);
  });
});
