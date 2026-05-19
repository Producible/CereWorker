export type ProviderAuthMode = 'apikey' | 'oauth';

export type ProviderRuntimeFamily =
  | 'anthropic'
  | 'anthropic-auth-token'
  | 'openai-responses'
  | 'openai-chat'
  | 'openai-codex'
  | 'google'
  | 'local';

export interface ProviderModelOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ProviderEndpointOption {
  value: string;
  label: string;
  hint?: string;
  baseUrl: string;
}

export interface CerebrumProviderDefinition {
  id: string;
  label: string;
  family: string;
  familyLabel: string;
  typeLabel?: string;
  authModes: readonly ProviderAuthMode[];
  envVar?: string;
  defaultModel: string;
  models: readonly ProviderModelOption[];
  runtimeFamily: ProviderRuntimeFamily;
  defaultBaseUrl?: string;
  endpointOptions?: readonly ProviderEndpointOption[];
}

export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const GOOGLE_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const XAI_BASE_URL = 'https://api.x.ai/v1';
export const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
export const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';
export const MOONSHOT_CN_BASE_URL = 'https://api.moonshot.cn/v1';
export const MINIMAX_BASE_URL = 'https://api.minimax.io/anthropic';
export const MINIMAX_CN_BASE_URL = 'https://api.minimaxi.com/anthropic';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
export const DEFAULT_OPENAI_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.7';

export const CEREBRUM_PROVIDERS: readonly CerebrumProviderDefinition[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    family: 'anthropic',
    familyLabel: 'Anthropic',
    typeLabel: 'Claude',
    authModes: ['apikey'],
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-4-7',
    models: [
      { value: 'claude-opus-4-7', label: 'Claude Opus 4.7', hint: 'default, most capable, frontier reasoning + agentic coding, new' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'best balance of speed and intelligence' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', hint: 'fastest, cheapest' },
      { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', hint: 'previous flagship' },
      { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', hint: 'previous gen Sonnet' },
    ],
    runtimeFamily: 'anthropic',
  },
  {
    id: 'openai',
    label: 'OpenAI (API Key)',
    family: 'openai',
    familyLabel: 'OpenAI',
    typeLabel: 'API',
    authModes: ['apikey'],
    envVar: 'OPENAI_API_KEY',
    defaultModel: DEFAULT_OPENAI_MODEL,
    models: [
      { value: DEFAULT_OPENAI_MODEL, label: 'GPT-5.5', hint: 'default, frontier intelligence for coding & professional work, new' },
      { value: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', hint: 'more compute for hardest problems via Responses API, new' },
      { value: 'gpt-5.4', label: 'GPT-5.4', hint: 'previous frontier, cheaper' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', hint: 'strongest mini model, coding + computer use, new' },
      { value: 'o3', label: 'o3', hint: 'powerful reasoning model' },
    ],
    runtimeFamily: 'openai-responses',
  },
  {
    id: 'openai-codex',
    label: 'OpenAI Codex (ChatGPT OAuth)',
    family: 'openai',
    familyLabel: 'OpenAI',
    typeLabel: 'Codex (ChatGPT OAuth)',
    authModes: ['oauth'],
    defaultModel: DEFAULT_OPENAI_CODEX_MODEL,
    models: [
      { value: DEFAULT_OPENAI_CODEX_MODEL, label: 'GPT-5.5', hint: 'default, latest Codex-capable GPT model, new' },
      { value: 'gpt-5.4', label: 'GPT-5.4', hint: 'previous Codex default' },
      { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', hint: 'previous Codex specialist model' },
      { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', hint: 'strongest long-horizon legacy Codex model' },
      { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', hint: 'balanced legacy Codex model' },
    ],
    runtimeFamily: 'openai-codex',
    defaultBaseUrl: OPENAI_CODEX_BASE_URL,
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    family: 'google',
    familyLabel: 'Google',
    typeLabel: 'Gemini',
    authModes: ['apikey', 'oauth'],
    envVar: 'GOOGLE_API_KEY',
    defaultModel: 'gemini-2.5-pro',
    models: [
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', hint: 'default, deep reasoning, most capable GA' },
      { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', hint: 'frontier-class at flash-lite cost, new' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'best price-performance, 1M context' },
      { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', hint: 'fastest, cheapest stable' },
      { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)', hint: 'next gen, advanced agentic (preview)' },
    ],
    runtimeFamily: 'google',
    defaultBaseUrl: GOOGLE_OPENAI_BASE_URL,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    family: 'openrouter',
    familyLabel: 'OpenRouter',
    authModes: ['apikey'],
    envVar: 'OPENROUTER_API_KEY',
    defaultModel: 'auto',
    models: [
      { value: 'auto', label: 'OpenRouter Auto', hint: 'default, automatic provider routing' },
      { value: 'openrouter/owl-alpha', label: 'Owl Alpha', hint: 'agentic foundation, native tool use, new' },
      { value: 'openrouter/hunter-alpha', label: 'Hunter Alpha', hint: '1T-param frontier intelligence, 1M context' },
      { value: 'openrouter/healer-alpha', label: 'Healer Alpha', hint: 'omni-modal vision + audio reasoning' },
      { value: 'openrouter/aurora-alpha', label: 'Aurora Alpha', hint: 'speed-focused coding/realtime, new' },
    ],
    runtimeFamily: 'openai-chat',
    defaultBaseUrl: OPENROUTER_BASE_URL,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    family: 'deepseek',
    familyLabel: 'DeepSeek',
    authModes: ['apikey'],
    envVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-pro',
    models: [
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', hint: 'default, advanced reasoning, 1M context, new' },
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', hint: 'faster, thinking + non-thinking modes, new' },
      { value: 'deepseek-chat', label: 'DeepSeek Chat', hint: 'legacy alias, non-thinking V4 Flash' },
      { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner', hint: 'legacy alias, thinking V4 Flash' },
    ],
    runtimeFamily: 'openai-chat',
    defaultBaseUrl: DEEPSEEK_BASE_URL,
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    family: 'xai',
    familyLabel: 'xAI',
    typeLabel: 'Grok',
    authModes: ['apikey'],
    envVar: 'XAI_API_KEY',
    defaultModel: 'grok-4.3',
    models: [
      { value: 'grok-4.3', label: 'Grok 4.3', hint: 'default, most intelligent and fastest, new' },
      { value: 'grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning', hint: 'extended reasoning, 1M context, new' },
      { value: 'grok-4.20-0309-non-reasoning', label: 'Grok 4.20 Non-Reasoning', hint: 'standard non-reasoning variant, new' },
      { value: 'grok-4.20-multi-agent-0309', label: 'Grok 4.20 Multi-Agent', hint: 'multi-agent, 2M context, new' },
      { value: 'grok-code-fast-1', label: 'Grok Code Fast 1', hint: 'code-focused Grok model' },
    ],
    runtimeFamily: 'openai-chat',
    defaultBaseUrl: XAI_BASE_URL,
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    family: 'mistral',
    familyLabel: 'Mistral',
    typeLabel: 'AI',
    authModes: ['apikey'],
    envVar: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-medium-3.5-26-04',
    models: [
      { value: 'mistral-medium-3.5-26-04', label: 'Mistral Medium 3.5', hint: 'default, frontier multimodal, agentic + coding, new' },
      { value: 'mistral-large-latest', label: 'Mistral Large (latest)', hint: 'broadest capability (auto-updating alias)' },
      { value: 'devstral-2-25-12', label: 'Devstral 2', hint: 'frontier code agents, new' },
      { value: 'magistral-medium-1-2-25-09', label: 'Magistral Medium 1.2', hint: 'frontier reasoning, new' },
      { value: 'codestral-latest', label: 'Codestral (latest)', hint: 'specialized code completion' },
    ],
    runtimeFamily: 'openai-chat',
    defaultBaseUrl: MISTRAL_BASE_URL,
  },
  {
    id: 'together',
    label: 'Together AI',
    family: 'together',
    familyLabel: 'Together',
    typeLabel: 'AI',
    authModes: ['apikey'],
    envVar: 'TOGETHER_API_KEY',
    defaultModel: 'moonshotai/Kimi-K2.6',
    models: [
      { value: 'moonshotai/Kimi-K2.6', label: 'Kimi K2.6', hint: 'default, newest curated, top performer, new' },
      { value: 'deepseek-ai/DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro', hint: 'advanced reasoning, 512K context, new' },
      { value: 'zai-org/GLM-5.1', label: 'GLM 5.1', hint: 'strong instruction-following, new' },
      { value: 'Qwen/Qwen3.6-Plus', label: 'Qwen 3.6 Plus', hint: 'million-token context, new' },
      { value: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Instruct Turbo', hint: 'fast open model' },
    ],
    runtimeFamily: 'openai-chat',
    defaultBaseUrl: TOGETHER_BASE_URL,
  },
  {
    id: 'moonshot',
    label: 'Moonshot AI (Kimi)',
    family: 'moonshot',
    familyLabel: 'Moonshot',
    typeLabel: 'Kimi',
    authModes: ['apikey'],
    envVar: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k2.6',
    models: [
      { value: 'kimi-k2.6', label: 'Kimi K2.6', hint: 'default, most intelligent multimodal, 256k context, new' },
      { value: 'kimi-k2.5', label: 'Kimi K2.5', hint: 'versatile multimodal, 256k context' },
      { value: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', hint: 'long-term reasoning' },
      { value: 'kimi-k2-thinking-turbo', label: 'Kimi K2 Thinking Turbo', hint: 'faster reasoning variant' },
      { value: 'kimi-k2-turbo-preview', label: 'Kimi K2 Turbo', hint: 'lowest-latency Kimi variant' },
    ],
    runtimeFamily: 'openai-chat',
    defaultBaseUrl: MOONSHOT_BASE_URL,
    endpointOptions: [
      { value: 'global', label: 'Global endpoint', hint: 'api.moonshot.ai', baseUrl: MOONSHOT_BASE_URL },
      { value: 'cn', label: 'CN endpoint', hint: 'api.moonshot.cn', baseUrl: MOONSHOT_CN_BASE_URL },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    family: 'minimax',
    familyLabel: 'MiniMax',
    typeLabel: 'API',
    authModes: ['apikey'],
    envVar: 'MINIMAX_API_KEY',
    defaultModel: DEFAULT_MINIMAX_MODEL,
    models: [
      { value: 'MiniMax-M2.7', label: 'MiniMax M2.7', hint: 'default, recommended MiniMax model' },
      { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', hint: 'faster MiniMax variant' },
      { value: 'MiniMax-M2.5', label: 'MiniMax M2.5', hint: 'previous gen, new (kept for compat)' },
    ],
    runtimeFamily: 'anthropic-auth-token',
    defaultBaseUrl: MINIMAX_BASE_URL,
    endpointOptions: [
      { value: 'global', label: 'Global endpoint', hint: 'api.minimax.io', baseUrl: MINIMAX_BASE_URL },
      { value: 'cn', label: 'CN endpoint', hint: 'api.minimaxi.com', baseUrl: MINIMAX_CN_BASE_URL },
    ],
  },
  {
    id: 'minimax-portal',
    label: 'MiniMax Portal (OAuth)',
    family: 'minimax',
    familyLabel: 'MiniMax',
    typeLabel: 'Portal (OAuth)',
    authModes: ['oauth'],
    defaultModel: DEFAULT_MINIMAX_MODEL,
    models: [
      { value: 'MiniMax-M2.7', label: 'MiniMax M2.7', hint: 'default, recommended MiniMax model' },
      { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', hint: 'faster MiniMax variant' },
      { value: 'MiniMax-M2.5', label: 'MiniMax M2.5', hint: 'previous gen, new (kept for compat)' },
    ],
    runtimeFamily: 'anthropic-auth-token',
    defaultBaseUrl: MINIMAX_BASE_URL,
    endpointOptions: [
      { value: 'global', label: 'Global endpoint', hint: 'api.minimax.io', baseUrl: MINIMAX_BASE_URL },
      { value: 'cn', label: 'CN endpoint', hint: 'api.minimaxi.com', baseUrl: MINIMAX_CN_BASE_URL },
    ],
  },
  {
    id: 'local',
    label: 'Local (Ollama / vLLM)',
    family: 'local',
    familyLabel: 'Local',
    typeLabel: 'Ollama / vLLM',
    authModes: ['apikey'],
    defaultModel: 'llama3.3',
    models: [],
    runtimeFamily: 'local',
  },
] as const;

const CEREBRUM_PROVIDER_MAP = new Map(
  CEREBRUM_PROVIDERS.map((provider) => [provider.id, provider] as const),
);

export function listCerebrumProviders(): CerebrumProviderDefinition[] {
  return [...CEREBRUM_PROVIDERS];
}

export interface CerebrumProviderFamilyOption {
  id: string;
  label: string;
  hint?: string;
}

export function getCerebrumProvider(providerId: string): CerebrumProviderDefinition | undefined {
  return CEREBRUM_PROVIDER_MAP.get(providerId);
}

export function getCerebrumProviderFamily(familyId: string): CerebrumProviderDefinition[] {
  return CEREBRUM_PROVIDERS.filter((provider) => provider.family === familyId);
}

export function listCerebrumProviderFamilies(): CerebrumProviderFamilyOption[] {
  const seen = new Set<string>();
  const families: CerebrumProviderFamilyOption[] = [];

  for (const provider of CEREBRUM_PROVIDERS) {
    if (seen.has(provider.family)) {
      continue;
    }
    seen.add(provider.family);

    const variants = getCerebrumProviderFamily(provider.family);
    const hint = variants.length > 1
      ? variants
          .map((variant) => variant.typeLabel ?? variant.label)
          .join(' | ')
      : provider.typeLabel;

    families.push({
      id: provider.family,
      label: provider.familyLabel,
      ...(hint ? { hint } : {}),
    });
  }

  return families;
}

export function getProviderModels(providerId: string): ProviderModelOption[] {
  return [...(getCerebrumProvider(providerId)?.models ?? [])];
}

export function getProviderAuthModes(providerId: string): ProviderAuthMode[] {
  return [...(getCerebrumProvider(providerId)?.authModes ?? ['apikey'])];
}

export function getProviderEnvVar(providerId: string): string | undefined {
  return getCerebrumProvider(providerId)?.envVar;
}

export function getProviderDefaultModel(providerId: string): string | undefined {
  return getCerebrumProvider(providerId)?.defaultModel;
}

export function getProviderDefaultBaseUrl(providerId: string): string | undefined {
  return getCerebrumProvider(providerId)?.defaultBaseUrl;
}

export function getProviderEndpointOptions(providerId: string): ProviderEndpointOption[] {
  return [...(getCerebrumProvider(providerId)?.endpointOptions ?? [])];
}

export const PROVIDER_ENV_VAR_MAP = Object.fromEntries(
  CEREBRUM_PROVIDERS.flatMap((provider) => (
    provider.envVar ? [[provider.id, provider.envVar] as const] : []
  )),
) as Record<string, string>;
