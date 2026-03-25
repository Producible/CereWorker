import { clack, guardCancel } from '../prompter.js';
import { DiscoveryEngine, type DiscoveryResult, type CerebrumAdapter } from '@cereworker/core';

export interface DiscoveryStepResult {
  name: string;
  role: string;
  traits: string[];
  trainingPairs: DiscoveryResult['trainingPairs'];
}

/**
 * Interactive discovery step: a multi-turn conversation with the LLM
 * to learn the instance's identity. Replaces profileStep() on first run.
 */
export async function discoveryStep(cerebrum: CerebrumAdapter): Promise<DiscoveryStepResult> {
  clack.log.step('Discovery — let me learn about my role through conversation');
  clack.log.info('I\'ll ask a few questions to understand who I am and what I\'ll be doing.\n');

  let result: DiscoveryResult | null = null;

  const engine = new DiscoveryEngine(cerebrum, {
    sendMessage: (content) => {
      // Strip the <discovery_complete> block from displayed output
      const display = content.replace(/<discovery_complete>[\s\S]*?<\/discovery_complete>/g, '').trim();
      if (display) {
        clack.log.message(display);
      }
    },
    getUserInput: async () => {
      const input = guardCancel(
        await clack.text({
          message: '>',
          placeholder: 'Type your answer...',
          validate: (v) => (v.trim().length === 0 ? 'Please enter a response' : undefined),
        }),
      );
      return input;
    },
    onComplete: (r) => {
      result = r;
    },
  });

  try {
    result = await engine.run();
  } catch (err) {
    clack.log.warn(`Discovery conversation failed: ${err}. Falling back to manual profile setup.`);
    // Import dynamically to avoid circular dependency
    const { profileStep } = await import('./profile.js');
    const profile = await profileStep();
    return { ...profile, trainingPairs: [] };
  }

  clack.log.success(`Got it! I'm ${result.name}, role: ${result.role}`);
  if (result.traits.length > 0) {
    clack.log.info(`Traits: ${result.traits.join(', ')}`);
  }

  return {
    name: result.name,
    role: result.role,
    traits: result.traits,
    trainingPairs: result.trainingPairs,
  };
}
