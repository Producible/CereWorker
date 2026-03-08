import type { SkillEntry } from './types.js';

export class SkillRegistry {
  private skills = new Map<string, SkillEntry>();

  register(skill: SkillEntry): void {
    this.skills.set(skill.name, skill);
  }

  registerAll(skills: SkillEntry[]): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  get(name: string): SkillEntry | undefined {
    return this.skills.get(name);
  }

  list(): SkillEntry[] {
    return Array.from(this.skills.values());
  }

  buildPrompt(): string {
    const skills = this.list();
    if (skills.length === 0) return '';

    const sections = skills.map((skill) => {
      const emoji = skill.metadata?.cereworker?.emoji ?? '';
      return `## ${emoji} ${skill.name}\n${skill.description}\n\n${skill.content}`;
    });

    return `# Available Skills\n\n${sections.join('\n\n---\n\n')}`;
  }

  clear(): void {
    this.skills.clear();
  }
}
