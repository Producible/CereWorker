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

export const DEFAULT_OPENAI_MODEL = 'gpt-5.4';
export const DEFAULT_OPENAI_CODEX_MODEL = 'gpt-5.4';
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
    defaultModel: 'claude-sonnet-4-6',
    models: [
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'default, best balance of speed and intelligence' },
      { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', hint: 'most capable, best for agents and coding' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', hint: 'fastest, cheapest' },
      { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', hint: 'previous gen, proven' },
      { value: 'claude-opus-4-5', label: 'Claude Opus 4.5', hint: 'previous gen Opus' },
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
      { value: DEFAULT_OPENAI_MODEL, label: 'GPT-5.4', hint: 'default, frontier intelligence, 1M context' },
      { value: 'gpt-5-mini', label: 'GPT-5 Mini', hint: 'fast, cost efficient, 400K context' },
      { value: 'o3', label: 'o3', hint: 'most powerful reasoning model' },
      { value: 'o4-mini', label: 'o4-mini', hint: 'efficient reasoning, half the cost of o3' },
      { value: 'gpt-4.1', label: 'GPT-4.1', hint: '1M context, strong coding' },
      { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', hint: '1M context, fast' },
      { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', hint: '1M context, cheapest' },
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
      { value: DEFAULT_OPENAI_CODEX_MODEL, label: 'GPT-5.4', hint: 'default, latest Codex-capable GPT model' },
      { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', hint: 'previous Codex specialist model' },
      { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', hint: 'strongest long-horizon legacy Codex model' },
      { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', hint: 'balanced legacy Codex model' },
      { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', hint: 'faster, cheaper legacy Codex model' },
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
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', hint: 'default, deep reasoning' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'best price-performance, 1M context' },
      { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', hint: 'fastest, cheapest' },
      { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)', hint: 'next gen, advanced agentic' },
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)', hint: 'next gen, frontier-class' },
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
      { value: 'openrouter/hunter-alpha', label: 'Hunter Alpha', hint: 'reasoning-oriented OpenRouter model' },
      { value: 'openrouter/healer-alpha', label: 'Healer Alpha', hint: 'multimodal OpenRouter reasoning model' },
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
    defaultModel: 'deepseek-chat',
    models: [
      { value: 'deepseek-chat', label: 'DeepSeek Chat', hint: 'default, general-purpose model' },
      { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner', hint: 'reasoning-focused model' },
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
    defaultModel: 'grok-4',
    models: [
      { value: 'grok-4', label: 'Grok 4', hint: 'default, flagship reasoning model' },
      { value: 'grok-4-fast', label: 'Grok 4 Fast', hint: 'faster, multimodal' },
      { value: 'grok-4-fast-non-reasoning', label: 'Grok 4 Fast (Non-Reasoning)', hint: 'fastest direct-response variant' },
      { value: 'grok-3-mini', label: 'Grok 3 Mini', hint: 'smaller reasoning model' },
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
    defaultModel: 'mistral-large-latest',
    models: [
      { value: 'mistral-large-latest', label: 'Mistral Large (latest)', hint: 'default, broadest capability' },
      { value: 'devstral-medium-latest', label: 'Devstral 2 (latest)', hint: 'coding-focused model' },
      { value: 'codestral-latest', label: 'Codestral (latest)', hint: 'specialized code model' },
      { value: 'mistral-medium-2508', label: 'Mistral Medium 3.1', hint: 'balanced mid-tier model' },
      { value: 'mistral-small-latest', label: 'Mistral Small (latest)', hint: 'smaller, faster model' },
      { value: 'pixtral-large-latest', label: 'Pixtral Large (latest)', hint: 'strong multimodal model' },
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
    defaultModel: 'moonshotai/Kimi-K2.5',
    models: [
      { value: 'moonshotai/Kimi-K2.5', label: 'Kimi K2.5', hint: 'default, strongest curated Together model' },
      { value: 'zai-org/GLM-4.7', label: 'GLM 4.7 Fp8', hint: 'broad general-purpose model' },
      { value: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Instruct Turbo', hint: 'fast open model' },
      { value: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', label: 'Llama 4 Scout 17B 16E', hint: 'large-context multimodal model' },
      { value: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', label: 'Llama 4 Maverick 17B 128E', hint: 'larger multimodal open model' },
      { value: 'deepseek-ai/DeepSeek-V3.1', label: 'DeepSeek V3.1', hint: 'strong text model on Together' },
      { value: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1', hint: 'reasoning model on Together' },
      { value: 'moonshotai/Kimi-K2-Instruct-0905', label: 'Kimi K2-Instruct 0905', hint: 'instruction-tuned Kimi fallback' },
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
    defaultModel: 'kimi-k2.5',
    models: [
      { value: 'kimi-k2.5', label: 'Kimi K2.5', hint: 'default, strongest general model' },
      { value: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', hint: 'reasoning-focused model' },
      { value: 'kimi-k2-thinking-turbo', label: 'Kimi K2 Thinking Turbo', hint: 'faster reasoning variant' },
      { value: 'kimi-k2-turbo', label: 'Kimi K2 Turbo', hint: 'lowest-latency Kimi variant' },
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
