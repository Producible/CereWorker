import { describe, expect, it } from 'vitest';
import { DEFAULT_OPENAI_CODEX_MODEL, getProviderModels } from './cerebrum-models.js';

describe('getProviderModels', () => {
  it('makes GPT-5.5 the recommended OpenAI Codex model', () => {
    const models = getProviderModels('openai-codex');

    expect(models[0]?.value).toBe(DEFAULT_OPENAI_CODEX_MODEL);
    expect(models[0]?.label).toBe('GPT-5.5');
  });

  it('exposes the current OpenAI Codex model lineup', () => {
    expect(getProviderModels('openai-codex')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'gpt-5.4' }),
        expect.objectContaining({ value: 'gpt-5.4-mini' }),
        expect.objectContaining({ value: 'gpt-5.3-codex' }),
        expect.objectContaining({ value: 'gpt-5.3-codex-spark' }),
      ]),
    );
  });
});
