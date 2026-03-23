import { clack, guardCancel } from '../prompter.js';

export interface ProfileResult {
  name: string;
  role: string;
  traits: string[];
}

const ROLE_OPTIONS = [
  { value: 'full-stack developer', label: 'Full-stack developer' },
  { value: 'backend engineer', label: 'Backend engineer' },
  { value: 'frontend developer', label: 'Frontend developer' },
  { value: 'devops / sre', label: 'DevOps / SRE' },
  { value: 'data scientist', label: 'Data scientist' },
  { value: 'security researcher', label: 'Security researcher' },
  { value: 'technical writer', label: 'Technical writer' },
  { value: 'general-purpose assistant', label: 'General-purpose assistant' },
  { value: '__custom', label: 'Custom...' },
];

const TRAIT_OPTIONS = [
  { value: 'concise', label: 'Concise', hint: 'short, direct responses' },
  { value: 'thorough', label: 'Thorough', hint: 'detailed explanations' },
  { value: 'proactive', label: 'Proactive', hint: 'suggest improvements without being asked' },
  { value: 'cautious', label: 'Cautious', hint: 'always ask before destructive actions' },
  { value: 'opinionated', label: 'Opinionated', hint: 'push back on bad patterns' },
  { value: 'friendly', label: 'Friendly', hint: 'warm, conversational tone' },
  { value: 'formal', label: 'Formal', hint: 'professional, structured communication' },
];

export async function profileStep(): Promise<ProfileResult> {
  clack.log.step('Worker profile');

  const name = guardCancel(
    await clack.text({
      message: 'What should I call myself?',
      placeholder: 'Cere',
      defaultValue: 'Cere',
    }),
  );

  let role = guardCancel(
    await clack.select({
      message: "What's my primary role?",
      options: ROLE_OPTIONS,
    }),
  ) as string;

  if (role === '__custom') {
    role = guardCancel(
      await clack.text({
        message: 'Describe your role:',
        placeholder: 'e.g. ML engineer, game developer',
        validate: (v) => (v.length === 0 ? 'Role cannot be empty' : undefined),
      }),
    );
  }

  const selectedTraits = guardCancel(
    await clack.multiselect({
      message: 'What characteristics should I have?',
      options: TRAIT_OPTIONS,
      required: false,
    }),
  ) as string[];

  return { name, role, traits: selectedTraits };
}
