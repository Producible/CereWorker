import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MINIMAX_MODEL,
  DEFAULT_OPENAI_CODEX_MODEL,
  getCerebrumProvider,
  getCerebrumProviderFamily,
  getProviderEndpointOptions,
  getProviderModels,
  listCerebrumProviderFamilies,
  listCerebrumProviders,
} from './cerebrum-providers.js';

describe('cerebrum provider registry', () => {
  it('includes the expanded common provider set', () => {
    const providerIds = listCerebrumProviders().map((provider) => provider.id);
    expect(providerIds).toEqual(expect.arrayContaining([
      'openrouter',
      'deepseek',
      'xai',
      'mistral',
      'together',
      'moonshot',
      'minimax',
      'minimax-portal',
    ]));
  });

  it('makes GPT-5.5 the recommended OpenAI Codex model', () => {
    const models = getProviderModels('openai-codex');
    expect(models[0]?.value).toBe(DEFAULT_OPENAI_CODEX_MODEL);
    expect(models[0]?.label).toBe('GPT-5.5');
  });

  it('makes MiniMax M2.7 the default for MiniMax providers', () => {
    expect(getCerebrumProvider('minimax')?.defaultModel).toBe(DEFAULT_MINIMAX_MODEL);
    expect(getCerebrumProvider('minimax-portal')?.defaultModel).toBe(DEFAULT_MINIMAX_MODEL);
  });

  it('exposes Moonshot and MiniMax endpoint choices', () => {
    expect(getProviderEndpointOptions('moonshot')).toHaveLength(2);
    expect(getProviderEndpointOptions('minimax')).toHaveLength(2);
    expect(getProviderEndpointOptions('minimax-portal')).toHaveLength(2);
  });

  it('groups OpenAI and MiniMax providers into families', () => {
    expect(getCerebrumProviderFamily('openai').map((provider) => provider.id)).toEqual([
      'openai',
      'openai-codex',
    ]);
    expect(getCerebrumProviderFamily('minimax').map((provider) => provider.id)).toEqual([
      'minimax',
      'minimax-portal',
    ]);
  });

  it('lists provider families with type hints for grouped providers', () => {
    const families = listCerebrumProviderFamilies();
    expect(families).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'openai',
        label: 'OpenAI',
        hint: 'API | Codex (ChatGPT OAuth)',
      }),
      expect.objectContaining({
        id: 'minimax',
        label: 'MiniMax',
        hint: 'API | Portal (OAuth)',
      }),
    ]));
  });
});
