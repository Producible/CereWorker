import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamTextMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());
const toolMock = vi.hoisted(() => vi.fn());
const stepCountIsMock = vi.hoisted(() => vi.fn());
const jsonSchemaMock = vi.hoisted(() => vi.fn((schema: unknown) => ({
  jsonSchema: typeof schema === 'function' ? (schema as () => unknown)() : schema,
})));
const createOpenAIMock = vi.hoisted(() => vi.fn());
const openAIChatMock = vi.hoisted(() => vi.fn());
const createAnthropicMock = vi.hoisted(() => vi.fn());
const tokenStoreLoadMock = vi.hoisted(() => vi.fn());
const tokenStoreSaveMock = vi.hoisted(() => vi.fn());
const getOpenAICodexApiKeyMock = vi.hoisted(() => vi.fn());
const refreshMiniMaxPortalTokenMock = vi.hoisted(() => vi.fn());

vi.mock('ai', () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
  jsonSchema: jsonSchemaMock,
  tool: toolMock,
  stepCountIs: stepCountIsMock,
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: createOpenAIMock,
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: createAnthropicMock,
}));

vi.mock('./oauth/index.js', () => {
  class MockTokenStore {
    load = tokenStoreLoadMock;
    save = tokenStoreSaveMock;
    isExpired(): boolean {
      return false;
    }
  }

  return {
    TokenStore: MockTokenStore,
    refreshAccessToken: vi.fn(),
    refreshMiniMaxPortalToken: refreshMiniMaxPortalTokenMock,
    OAUTH_PROVIDERS: {},
  };
});

vi.mock('./oauth/pi-auth.js', () => ({
  getOpenAICodexApiKey: getOpenAICodexApiKeyMock,
  refreshGoogleToken: vi.fn(),
}));

import { CerebrumProvider } from './provider.js';

describe('CerebrumProvider OpenAI Codex OAuth', () => {
  const responsesMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    streamTextMock.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'hello' };
      })(),
    });
    generateTextMock.mockResolvedValue({ text: 'generated text' });
    toolMock.mockImplementation((definition: unknown) => definition);
    stepCountIsMock.mockReturnValue(Symbol('stopWhen'));
    responsesMock.mockImplementation((modelId: string) => ({ modelId }));
    openAIChatMock.mockImplementation((modelId: string) => ({ modelId, transport: 'chat' }));
    createOpenAIMock.mockImplementation(() => ({
      responses: responsesMock,
      chat: openAIChatMock,
    }));
    createAnthropicMock.mockImplementation(() => vi.fn());
    tokenStoreLoadMock.mockReturnValue({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt: Date.now() + 60_000,
      tokenType: 'bearer',
      accountId: 'acct_123',
    });
    getOpenAICodexApiKeyMock.mockResolvedValue({
      apiKey: 'access-123',
      tokens: {
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        expiresAt: Date.now() + 60_000,
        tokenType: 'bearer',
        accountId: 'acct_123',
      },
    });
  });

  it('uses Codex base URL and required headers for openai-codex', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.4',
      providers: {
        'openai-codex': {
          auth: 'oauth',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await (provider as unknown as { getModel: (provider: string, model: string) => Promise<unknown> })
      .getModel('openai-codex', 'gpt-5.4');

    expect(tokenStoreLoadMock).toHaveBeenCalledWith('openai-codex');
    expect(tokenStoreSaveMock).toHaveBeenCalledWith(
      'openai-codex',
      expect.objectContaining({ accountId: 'acct_123' }),
    );
    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'access-123',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      headers: expect.objectContaining({
        'chatgpt-account-id': 'acct_123',
        'OpenAI-Beta': 'responses=experimental',
        originator: 'cereworker',
        'User-Agent': 'cereworker',
      }),
    }));
    expect(responsesMock).toHaveBeenCalledWith('gpt-5.4');
  });

  it('treats legacy openai OAuth configs as openai-codex', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.4',
      providers: {
        openai: {
          auth: 'oauth',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await (provider as unknown as { getModel: (provider: string, model: string) => Promise<unknown> })
      .getModel('openai', 'gpt-5.4');

    expect(tokenStoreLoadMock).toHaveBeenCalledWith('openai-codex');
    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://chatgpt.com/backend-api/codex',
    }));
  });

  it('fails with a clear error when account metadata is missing', async () => {
    getOpenAICodexApiKeyMock.mockResolvedValueOnce({
      apiKey: 'access-123',
      tokens: {
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        expiresAt: Date.now() + 60_000,
        tokenType: 'bearer',
      },
    });

    const provider = new CerebrumProvider({
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.2-codex',
      providers: {
        'openai-codex': {
          auth: 'oauth',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await expect(
      (provider as unknown as { getModel: (provider: string, model: string) => Promise<unknown> })
        .getModel('openai-codex', 'gpt-5.2-codex'),
    ).rejects.toThrow('missing account metadata');
  });

  it('passes OpenAI instructions for Codex streaming requests', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.4',
      providers: {
        'openai-codex': {
          auth: 'oauth',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.stream(
      [
        { id: 'system', role: 'system', content: 'Follow the system prompt.', timestamp: 0 },
        { id: 'user-1', role: 'user', content: 'Hi there', timestamp: 1 },
      ],
      {},
      {
        onChunk: vi.fn(),
        onToolCall: vi.fn(async () => ({ callId: 'unused', output: '', isError: false })),
        onFinish: vi.fn(),
        onError: vi.fn(),
      },
    );

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const request = streamTextMock.mock.calls[0][0] as {
      providerOptions?: { openai?: { instructions?: string } };
      system?: string;
    };
    expect(request.providerOptions).toEqual({
      openai: {
        instructions: 'Follow the system prompt.',
        store: false,
      },
    });
    expect(request.temperature).toBeUndefined();
    expect(request.system).toBeUndefined();
  });

  it('normalizes legacy tool parameter maps to explicit JSON Schema objects', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.2-codex',
      providers: {
        'openai-codex': {
          auth: 'oauth',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.stream(
      [
        { id: 'system', role: 'system', content: 'Use tools carefully.', timestamp: 0 },
        { id: 'user-1', role: 'user', content: 'Hi there', timestamp: 1 },
      ],
      {
        spawn_agent: {
          description: 'Spawn a helper agent',
          parameters: {
            task: { type: 'string', description: 'Task to delegate', required: true },
            label: { type: 'string', description: 'Optional label', required: false },
          },
          execute: async () => 'ok',
        },
        noop: {
          description: 'Tool with no arguments',
          parameters: {},
          execute: async () => 'ok',
        },
      },
      {
        onChunk: vi.fn(),
        onToolCall: vi.fn(async () => ({ callId: 'unused', output: '', isError: false })),
        onFinish: vi.fn(),
        onError: vi.fn(),
      },
    );

    const request = streamTextMock.mock.calls[0][0] as {
      tools: Record<string, { inputSchema?: { jsonSchema?: unknown } }>;
    };

    expect(request.tools.spawn_agent.inputSchema?.jsonSchema).toEqual({
      type: 'object',
      properties: {
        task: {
          description: 'Task to delegate',
          type: 'string',
        },
        label: {
          description: 'Optional label',
          type: 'string',
        },
      },
      required: ['task'],
      additionalProperties: false,
    });
    expect(request.tools.noop.inputSchema?.jsonSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('flattens top-level union schemas into portable object schemas', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.2-codex',
      providers: {
        'openai-codex': {
          auth: 'oauth',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.stream(
      [
        { id: 'system', role: 'system', content: 'Use tools carefully.', timestamp: 0 },
        { id: 'user-1', role: 'user', content: 'Hi there', timestamp: 1 },
      ],
      {
        choose_action: {
          description: 'Choose an action',
          parameters: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  action: {
                    anyOf: [
                      { const: 'start', type: 'string' },
                      { const: 'stop', type: 'string' },
                    ],
                  },
                  count: { type: 'integer' },
                },
                required: ['action'],
              },
              {
                type: 'object',
                properties: {
                  action: { const: 'restart', type: 'string' },
                  count: { type: 'integer' },
                },
                required: ['action'],
              },
            ],
          },
          execute: async () => 'ok',
        },
      },
      {
        onChunk: vi.fn(),
        onToolCall: vi.fn(async () => ({ callId: 'unused', output: '', isError: false })),
        onFinish: vi.fn(),
        onError: vi.fn(),
      },
    );

    const request = streamTextMock.mock.calls[0][0] as {
      tools: Record<string, { inputSchema?: { jsonSchema?: unknown } }>;
    };

    expect(request.tools.choose_action.inputSchema?.jsonSchema).toEqual({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'restart'],
        },
        count: {
          type: 'integer',
        },
      },
      required: ['action'],
      additionalProperties: false,
    });
  });

  it('cleans Gemini schemas for compatibility', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'google',
      defaultModel: 'gemini-2.0-flash',
      providers: {
        google: {
          apiKey: 'google-test-key',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.stream(
      [
        { id: 'user-1', role: 'user', content: 'Hi there', timestamp: 1 },
      ],
      {
        analyze: {
          description: 'Analyze a payload',
          parameters: {
            type: 'object',
            properties: {
              count: {
                type: 'integer',
                minimum: 1,
              },
              nested: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mode: {
                    oneOf: [
                      { const: 'fast', type: 'string' },
                      { const: 'safe', type: 'string' },
                    ],
                  },
                },
              },
            },
            additionalProperties: false,
          },
          execute: async () => 'ok',
        },
      },
      {
        onChunk: vi.fn(),
        onToolCall: vi.fn(async () => ({ callId: 'unused', output: '', isError: false })),
        onFinish: vi.fn(),
        onError: vi.fn(),
      },
    );

    const request = streamTextMock.mock.calls[0][0] as {
      tools: Record<string, { inputSchema?: { jsonSchema?: unknown } }>;
    };

    expect(request.tools.analyze.inputSchema?.jsonSchema).toEqual({
      type: 'object',
      properties: {
        count: {
          type: 'number',
        },
        nested: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['fast', 'safe'],
            },
          },
        },
      },
    });
    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'google-test-key',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    }));
    expect(openAIChatMock).toHaveBeenCalledWith('gemini-2.0-flash');
  });

  it('normalizes older Google API hosts to the OpenAI-compatible Gemini endpoint', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'google',
      defaultModel: 'gemini-2.5-pro',
      providers: {
        google: {
          apiKey: 'google-test-key',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await (provider as unknown as { getModel: (provider: string, model: string) => Promise<unknown> })
      .getModel('google', 'gemini-2.5-pro');

    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'google-test-key',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    }));
    expect(openAIChatMock).toHaveBeenCalledWith('gemini-2.5-pro');
  });

  it('repairs partially orphaned tool transcripts instead of dropping the whole assistant turn', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.2-codex',
      providers: {
        'openai-codex': {
          auth: 'oauth',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.stream(
      [
        { id: 'user-1', role: 'user', content: 'Hi there', timestamp: 1 },
        {
          id: 'assistant-1',
          role: 'cerebrum',
          content: 'Working on it',
          timestamp: 2,
          toolCalls: [
            { id: 'call-1', name: ' spawn_agent ', args: { task: 'delegate' } },
            { id: 'call-2', name: 'query_agents', args: {} },
          ],
        },
        {
          id: 'tool-1',
          role: 'tool',
          content: 'Sub-agent abc spawned.',
          timestamp: 3,
          toolResult: {
            callId: 'call-1',
            output: 'Sub-agent abc spawned.',
            isError: false,
          },
          metadata: {
            toolName: ' spawn_agent ',
          },
        },
      ],
      {
        spawn_agent: {
          description: 'Spawn an agent',
          parameters: {},
          execute: async () => 'ok',
        },
        query_agents: {
          description: 'Query agents',
          parameters: {},
          execute: async () => 'ok',
        },
      },
      {
        onChunk: vi.fn(),
        onToolCall: vi.fn(async () => ({ callId: 'unused', output: '', isError: false })),
        onFinish: vi.fn(),
        onError: vi.fn(),
      },
    );

    const request = streamTextMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(request.messages).toHaveLength(3);
    expect(request.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Working on it' },
        {
          type: 'tool-call',
          toolCallId: 'call1',
          toolName: 'spawn_agent',
          input: { task: 'delegate' },
        },
      ],
    });
    expect(request.messages[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call1',
          toolName: 'spawn_agent',
          output: { type: 'text', value: 'Sub-agent abc spawned.' },
        },
      ],
    });
  });

  it('trims tool names from streamed tool-call parts before persisting them', async () => {
    streamTextMock.mockReturnValueOnce({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: ' spawn_agent ',
          input: { task: 'delegate' },
        };
        yield { type: 'text-delta', text: 'done' };
      })(),
    });

    const onFinish = vi.fn();
    const provider = new CerebrumProvider({
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.2-codex',
      providers: {
        'openai-codex': {
          auth: 'oauth',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.stream(
      [
        { id: 'user-1', role: 'user', content: 'Hi there', timestamp: 1 },
      ],
      {
        spawn_agent: {
          description: 'Spawn an agent',
          parameters: {},
          execute: async () => 'ok',
        },
      },
      {
        onChunk: vi.fn(),
        onToolCall: vi.fn(async () => ({ callId: 'unused', output: '', isError: false })),
        onFinish,
        onError: vi.fn(),
      },
    );

    expect(onFinish).toHaveBeenCalledWith(
      'done',
      [
        {
          id: 'call-1',
          name: 'spawn_agent',
          args: { task: 'delegate' },
        },
      ],
      expect.objectContaining({
        hadToolActivity: true,
        toolCallCount: 1,
        textChars: 4,
      }),
    );
  });

  it('uses fallback OpenAI instructions for Codex single-shot generation', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.4',
      providers: {
        'openai-codex': {
          auth: 'oauth',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.generate('Say hello');

    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: {
        openai: {
          instructions: 'You are the Cerebrum of CereWorker, a dual-LLM autonomous agent.',
          store: false,
        },
      },
    }));
    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('keeps temperature for non-Codex streaming requests', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'google',
      defaultModel: 'gemini-2.5-pro',
      providers: {
        google: {
          apiKey: 'google-test-key',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.stream(
      [
        { id: 'system', role: 'system', content: 'Use normal Gemini.', timestamp: 0 },
        { id: 'user-1', role: 'user', content: 'Hi there', timestamp: 1 },
      ],
      {},
      {
        onChunk: vi.fn(),
        onToolCall: vi.fn(async () => ({ callId: 'unused', output: '', isError: false })),
        onFinish: vi.fn(),
        onError: vi.fn(),
      },
    );

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(streamTextMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      system: 'Use normal Gemini.',
      temperature: 0.7,
    }));
  });

  it('uses OpenAI chat transport for OpenRouter models', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'openrouter',
      defaultModel: 'auto',
      providers: {
        openrouter: {
          apiKey: 'openrouter-test-key',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await (provider as unknown as { getModel: (provider: string, model: string) => Promise<unknown> })
      .getModel('openrouter', 'auto');

    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'openrouter-test-key',
      baseURL: 'https://openrouter.ai/api/v1',
    }));
    expect(openAIChatMock).toHaveBeenCalledWith('auto');
  });

  it('uses Anthropic auth-token transport for MiniMax providers', async () => {
    const anthropicModelMock = vi.fn();
    createAnthropicMock.mockImplementationOnce(() => anthropicModelMock);

    const provider = new CerebrumProvider({
      defaultProvider: 'minimax',
      defaultModel: 'MiniMax-M2.7',
      providers: {
        minimax: {
          apiKey: 'minimax-test-token',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await (provider as unknown as { getModel: (provider: string, model: string) => Promise<unknown> })
      .getModel('minimax', 'MiniMax-M2.7');

    expect(createAnthropicMock).toHaveBeenCalledWith(expect.objectContaining({
      authToken: 'minimax-test-token',
      baseURL: 'https://api.minimax.io/anthropic',
    }));
    expect(anthropicModelMock).toHaveBeenCalledWith('MiniMax-M2.7');
  });

  it('sanitizes Mistral tool-call IDs to strict9-compatible values', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'mistral',
      defaultModel: 'mistral-large-latest',
      providers: {
        mistral: {
          apiKey: 'mistral-test-key',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.stream(
      [
        { id: 'user-1', role: 'user', content: 'Hi there', timestamp: 1 },
        {
          id: 'assistant-1',
          role: 'cerebrum',
          content: 'Working on it',
          timestamp: 2,
          toolCalls: [
            { id: 'call_abc|item:456', name: 'spawn_agent', args: { task: 'delegate' } },
          ],
        },
        {
          id: 'tool-1',
          role: 'tool',
          content: 'Sub-agent abc spawned.',
          timestamp: 3,
          toolResult: {
            callId: 'call_abc|item:456',
            output: 'Sub-agent abc spawned.',
            isError: false,
          },
        },
      ],
      {
        spawn_agent: {
          description: 'Spawn an agent',
          parameters: {},
          execute: async () => 'ok',
        },
      },
      {
        onChunk: vi.fn(),
        onToolCall: vi.fn(async () => ({ callId: 'unused', output: '', isError: false })),
        onFinish: vi.fn(),
        onError: vi.fn(),
      },
    );

    const request = streamTextMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const assistantBlocks = request.messages[1]?.content as Array<{ toolCallId?: string }>;
    const toolBlocks = request.messages[2]?.content as Array<{ toolCallId?: string }>;

    expect(assistantBlocks[1]?.toolCallId).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(toolBlocks[0]?.toolCallId).toBe(assistantBlocks[1]?.toolCallId);
  });

  it('decodes HTML entities in xAI tool-call arguments', async () => {
    streamTextMock.mockReturnValueOnce({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'search',
          input: { query: 'Tom &amp; Jerry &quot;test&quot;' },
        };
        yield { type: 'text-delta', text: 'done' };
      })(),
    });

    const onFinish = vi.fn();
    const onToolCall = vi.fn(async () => ({ callId: 'call-1', output: 'ok', isError: false }));
    const provider = new CerebrumProvider({
      defaultProvider: 'xai',
      defaultModel: 'grok-4',
      providers: {
        xai: {
          apiKey: 'xai-test-key',
        },
      },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.stream(
      [
        { id: 'user-1', role: 'user', content: 'Hi there', timestamp: 1 },
      ],
      {
        search: {
          description: 'Search the web',
          parameters: {
            query: { type: 'string', required: true },
          },
          execute: async () => 'ok',
        },
      },
      {
        onChunk: vi.fn(),
        onToolCall,
        onFinish,
        onError: vi.fn(),
      },
    );

    expect(onFinish).toHaveBeenCalledWith(
      'done',
      [
        {
          id: 'call-1',
          name: 'search',
          args: { query: 'Tom & Jerry "test"' },
        },
      ],
      expect.objectContaining({
        hadToolActivity: true,
        toolCallCount: 1,
        textChars: 4,
      }),
    );

    const request = streamTextMock.mock.calls[0][0] as {
      tools: Record<string, { execute: (args: Record<string, unknown>, ctx: { toolCallId: string }) => Promise<string> }>;
    };
    await request.tools.search.execute(
      { query: 'Tom &amp; Jerry &quot;test&quot;' },
      { toolCallId: 'call-1' },
    );
    expect(onToolCall).toHaveBeenCalledWith({
      id: 'call-1',
      name: 'search',
      args: { query: 'Tom & Jerry "test"' },
    });
  });

  it('strips unsupported strict flags from xAI tool payloads', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const provider = new CerebrumProvider({
        defaultProvider: 'xai',
        defaultModel: 'grok-4',
        providers: {
          xai: {
            apiKey: 'xai-test-key',
          },
        },
        maxSteps: 10,
        temperature: 0.7,
      });

      await (provider as unknown as { getModel: (provider: string, model: string) => Promise<unknown> })
        .getModel('xai', 'grok-4');

      const options = createOpenAIMock.mock.calls[0][0] as { fetch?: typeof fetch };
      expect(options.fetch).toBeTypeOf('function');

      await options.fetch?.('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          tools: [
            {
              type: 'function',
              function: {
                name: 'search',
                strict: true,
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
        }),
      });

      const request = fetchMock.mock.calls[0]?.[1] as { body?: string };
      const payload = JSON.parse(request.body ?? '{}') as {
        tools?: Array<{ function?: { strict?: boolean } }>;
      };
      expect(payload.tools?.[0]?.function?.strict).toBeUndefined();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });
});

describe('CerebrumProvider abortSignal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamTextMock.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'hello' };
      })(),
    });
    toolMock.mockImplementation((definition: unknown) => definition);
    stepCountIsMock.mockReturnValue(Symbol('stopWhen'));
    createOpenAIMock.mockImplementation(() => {
      const provider = (modelId: string) => ({ modelId });
      provider.chat = (modelId: string) => ({ modelId, transport: 'chat' });
      return provider;
    });
  });

  it('forwards abortSignal to streamText when provided', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
      providers: { openai: { apiKey: 'test-key' } },
      maxSteps: 10,
      temperature: 0.7,
    });

    const ac = new AbortController();
    await provider.stream(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      {},
      { onChunk: () => {}, onToolCall: async () => ({ callId: '', output: '', isError: false }), onFinish: () => {}, onError: () => {} },
      { abortSignal: ac.signal },
    );

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const args = streamTextMock.mock.calls[0][0] as { abortSignal?: AbortSignal };
    expect(args.abortSignal).toBe(ac.signal);
  });

  it('does not include abortSignal when not provided', async () => {
    const provider = new CerebrumProvider({
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
      providers: { openai: { apiKey: 'test-key' } },
      maxSteps: 10,
      temperature: 0.7,
    });

    await provider.stream(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      {},
      { onChunk: () => {}, onToolCall: async () => ({ callId: '', output: '', isError: false }), onFinish: () => {}, onError: () => {} },
    );

    const args = streamTextMock.mock.calls[0][0] as { abortSignal?: AbortSignal };
    expect(args.abortSignal).toBeUndefined();
  });

  it('forwards finish metadata from the streamed response', async () => {
    streamTextMock.mockReturnValueOnce({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'workTool',
          input: {},
        };
        yield { type: 'text-delta', text: 'done' };
        yield { type: 'finish-step', finishReason: 'tool-calls', rawFinishReason: 'tool_calls' };
        yield { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop' };
      })(),
    });

    const provider = new CerebrumProvider({
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
      providers: { openai: { apiKey: 'test-key' } },
      maxSteps: 10,
      temperature: 0.7,
    });

    const onFinish = vi.fn();
    await provider.stream(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      {
        workTool: {
          description: 'work',
          parameters: {},
          execute: async () => 'unused',
        },
      },
      {
        onChunk: vi.fn(),
        onToolCall: async () => ({ callId: 'tool-1', output: 'ok', isError: false }),
        onFinish,
        onError: vi.fn(),
      },
    );

    expect(onFinish).toHaveBeenCalledWith(
      'done',
      [{ id: 'tool-1', name: 'workTool', args: {} }],
      {
        finishReason: 'stop',
        rawFinishReason: 'stop',
        stepFinishReasons: ['tool-calls'],
        chunkCount: 4,
        textChars: 4,
        toolCallCount: 1,
        hadToolActivity: true,
        stepCount: 1,
      },
    );
  });

  it('breaks out when a streamed tool call hangs and the abort signal fires', async () => {
    streamTextMock.mockImplementationOnce((request: {
      tools: Record<string, { execute: (args: Record<string, unknown>, context: { toolCallId: string }) => Promise<string> }>;
    }) => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'hangTool',
          input: {},
        };
        await request.tools.hangTool.execute({}, { toolCallId: 'tool-1' });
        yield { type: 'text-delta', text: 'done' };
      })(),
    }));

    const provider = new CerebrumProvider({
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
      providers: { openai: { apiKey: 'test-key' } },
      maxSteps: 10,
      temperature: 0.7,
    });

    const abortController = new AbortController();
    const onToolCall = vi.fn(() => new Promise<never>(() => {}));
    const onError = vi.fn();
    const streamPromise = provider.stream(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      {
        hangTool: {
          description: 'hang forever',
          parameters: {},
          execute: async () => 'unused',
        },
      },
      {
        onChunk: vi.fn(),
        onToolCall,
        onFinish: vi.fn(),
        onError,
      },
      { abortSignal: abortController.signal },
    );

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        abortController.abort();
        resolve();
      }, 0);
    });

    await expect(streamPromise).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Stream aborted',
    });
    expect(onToolCall).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Stream aborted' }));
  });

  it('still aborts promptly when iterator teardown hangs', async () => {
    streamTextMock.mockImplementationOnce(() => ({
      fullStream: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: () => new Promise<IteratorResult<unknown>>(() => {}),
        }),
      },
    }));

    const provider = new CerebrumProvider({
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
      providers: { openai: { apiKey: 'test-key' } },
      maxSteps: 10,
      temperature: 0.7,
    });

    const abortController = new AbortController();
    const onError = vi.fn();
    const streamPromise = provider.stream(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      {},
      {
        onChunk: vi.fn(),
        onToolCall: vi.fn(async () => ({ callId: '', output: '', isError: false })),
        onFinish: vi.fn(),
        onError,
      },
      { abortSignal: abortController.signal },
    );

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        abortController.abort();
        resolve();
      }, 0);
    });

    await expect(streamPromise).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Stream aborted',
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Stream aborted' }));
  });
});
