export interface SkillMetadata {
  cereworker?: {
    emoji?: string;
    requires?: {
      bins?: string[];
      env?: string[];
    };
    install?: SkillInstallSpec[];
  };
}

export interface SkillInstallSpec {
  kind: 'brew' | 'apt' | 'npm' | 'go';
  formula?: string;
  package?: string;
  bins?: string[];
  label?: string;
}

export interface SkillInvocationPolicy {
  userInvocable: boolean;
  disableModelInvocation: boolean;
}

export interface SkillEntry {
  name: string;
  description: string;
  content: string;
  metadata?: SkillMetadata;
  invocation?: SkillInvocationPolicy;
}
