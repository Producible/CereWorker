import { describe, expect, it } from 'vitest';
import { DEFAULT_OPENAI_CODEX_MODEL, getProviderModels } from './cerebrum-models.js';

describe('getProviderModels', () => {
  it('makes GPT-5.5 the recommended OpenAI Codex model', () => {
    const models = getProviderModels('openai-codex');

    expect(models[0]?.value).toBe(DEFAULT_OPENAI_CODEX_MODEL);
    expect(models[0]?.label).toBe('GPT-5.5');
  });

  it('keeps older Codex models available as fallbacks', () => {
    expect(getProviderModels('openai-codex')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'gpt-5.4' }),
        expect.objectContaining({ value: 'gpt-5.2-codex' }),
        expect.objectContaining({ value: 'gpt-5.1-codex-max' }),
        expect.objectContaining({ value: 'gpt-5.1-codex' }),
      ]),
    );
  });
});
