import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry } from './registry.js';
import type { SkillEntry } from './types.js';

function makeSkill(name: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name,
    description: `${name} description`,
    content: `${name} body content`,
    ...overrides,
  };
}

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it('registers and retrieves a skill by name', () => {
    const skill = makeSkill('test-skill');
    registry.register(skill);
    expect(registry.get('test-skill')).toBe(skill);
  });

  it('returns undefined for unknown skill', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered skills', () => {
    registry.register(makeSkill('a'));
    registry.register(makeSkill('b'));
    const names = registry.list().map((s) => s.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).toHaveLength(2);
  });

  it('overwrites skill with same name', () => {
    registry.register(makeSkill('x', { description: 'old' }));
    registry.register(makeSkill('x', { description: 'new' }));
    expect(registry.get('x')?.description).toBe('new');
    expect(registry.list()).toHaveLength(1);
  });

  it('registerAll adds multiple skills', () => {
    registry.registerAll([makeSkill('a'), makeSkill('b'), makeSkill('c')]);
    expect(registry.list()).toHaveLength(3);
  });

  it('registerAll with empty array is a no-op', () => {
    registry.registerAll([]);
    expect(registry.list()).toHaveLength(0);
  });

  it('buildPrompt returns empty string when no skills', () => {
    expect(registry.buildPrompt()).toBe('');
  });

  it('buildPrompt includes skill name and content', () => {
    registry.register(makeSkill('deploy', { content: 'deploy steps' }));
    const prompt = registry.buildPrompt();
    expect(prompt).toContain('# Available Skills');
    expect(prompt).toContain('deploy');
    expect(prompt).toContain('deploy steps');
  });

  it('buildPrompt includes emoji from metadata', () => {
    registry.register(
      makeSkill('rocket', {
        metadata: { cereworker: { emoji: '🚀' } },
      }),
    );
    const prompt = registry.buildPrompt();
    expect(prompt).toContain('🚀');
  });

  it('buildPrompt separates skills with ---', () => {
    registry.register(makeSkill('a'));
    registry.register(makeSkill('b'));
    const prompt = registry.buildPrompt();
    expect(prompt).toContain('---');
  });

  it('buildPrompt handles skill without metadata', () => {
    registry.register(makeSkill('plain'));
    const prompt = registry.buildPrompt();
    expect(prompt).toContain('plain');
    // Should not throw, emoji is just empty
    expect(prompt).toContain('##');
  });

  it('clear removes all skills', () => {
    registry.register(makeSkill('a'));
    registry.register(makeSkill('b'));
    registry.clear();
    expect(registry.list()).toHaveLength(0);
    expect(registry.get('a')).toBeUndefined();
  });

  it('operations work after clear', () => {
    registry.register(makeSkill('old'));
    registry.clear();
    registry.register(makeSkill('new'));
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('new')?.name).toBe('new');
  });
});
