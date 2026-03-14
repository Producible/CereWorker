import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import type { CerebrumAdapter, CerebellumAdapter, ToolDefinition } from './orchestrator.js';
import { ConversationStore } from './conversation.js';

function createMockCerebrum(): CerebrumAdapter {
  return {
    stream: vi.fn(async (_msgs, _tools, cb) => {
      cb.onChunk('hello');
      cb.onFinish('hello');
    }),
    summarize: vi.fn(async () => 'summary'),
  };
}

function createMockCerebellum(): CerebellumAdapter {
  return {
    isConnected: vi.fn(() => true),
    verifyToolResult: vi.fn(async () => ({ passed: true, checks: [], modelVerdict: true })),
    ingestTrainingData: vi.fn(async () => 5),
    startFineTune: vi.fn(async () => ({ jobId: 'ft-1', started: true, error: '' })),
    getFineTuneStatus: vi.fn(async () => null),
  };
}

function createTestTool(output = 'ok'): ToolDefinition {
  return {
    description: 'test tool',
    parameters: {},
    execute: vi.fn(async () => output),
  };
}

describe('Orchestrator', () => {
  let orch: Orchestrator;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  afterEach(async () => {
    await orch.stop();
  });

  // --- Constructor & options ---

  describe('constructor', () => {
    it('creates with default options', () => {
      expect(orch.getActiveConversationId()).toBeNull();
      expect(orch.getAutoMode()).toBe(false);
    });

    it('accepts custom conversation store', () => {
      const store = new ConversationStore();
      const conv = store.create();
      store.appendMessage(conv.id, 'user', 'hi');
      const o = new Orchestrator({ conversationStore: store });
      expect(o.getMessages(conv.id)).toHaveLength(1);
    });

    it('accepts custom compaction config', () => {
      // Compaction config is internal but we verify it doesn't throw
      const o = new Orchestrator({ compaction: { threshold: 0.5, contextWindow: 64000 } });
      expect(o).toBeInstanceOf(Orchestrator);
    });
  });

  // --- System context ---

  describe('system context', () => {
    it('returns null by default', () => {
      expect(orch.getSystemContext()).toBeNull();
    });

    it('stores and retrieves system context', () => {
      orch.setSystemContext('skills prompt');
      expect(orch.getSystemContext()).toBe('skills prompt');
    });

    it('overwrites previous context', () => {
      orch.setSystemContext('first');
      orch.setSystemContext('second');
      expect(orch.getSystemContext()).toBe('second');
    });
  });

  // --- Tool management ---

  describe('tool management', () => {
    it('registerTool makes tool available', () => {
      const tool = createTestTool();
      orch.registerTool('greet', tool);
      // Tool is used internally during sendMessage, verify it was registered
      // by checking unregister succeeds
      expect(orch.unregisterTool('greet')).toBe(true);
    });

    it('registerTools registers multiple tools', () => {
      orch.registerTools({
        tool_a: createTestTool(),
        tool_b: createTestTool(),
      });
      expect(orch.unregisterTool('tool_a')).toBe(true);
      expect(orch.unregisterTool('tool_b')).toBe(true);
    });

    it('unregisterTool returns false for non-existent tool', () => {
      expect(orch.unregisterTool('nonexistent')).toBe(false);
    });

    it('unregisterTool removes the tool', () => {
      orch.registerTool('temp', createTestTool());
      expect(orch.unregisterTool('temp')).toBe(true);
      expect(orch.unregisterTool('temp')).toBe(false);
    });
  });

  // --- Auto mode ---

  describe('auto mode', () => {
    it('defaults to false', () => {
      expect(orch.getAutoMode()).toBe(false);
    });

    it('setAutoMode changes the value', () => {
      orch.setAutoMode(true);
      expect(orch.getAutoMode()).toBe(true);
    });

    it('can toggle back to false', () => {
      orch.setAutoMode(true);
      orch.setAutoMode(false);
      expect(orch.getAutoMode()).toBe(false);
    });
  });

  // --- Gateway mode ---

  describe('gateway mode', () => {
    it('setGatewayMode sets mode to gateway with node count', () => {
      // No getter, but verify it doesn't throw and is used in system prompt
      orch.setGatewayMode('gateway', { connectedNodes: 3 });
    });

    it('setGatewayMode sets mode to node with URL', () => {
      orch.setGatewayMode('node', { gatewayUrl: 'ws://hub:18800' });
    });

    it('setGatewayMode sets standalone', () => {
      orch.setGatewayMode('standalone');
    });
  });

  // --- Conversation lifecycle ---

  describe('conversation lifecycle', () => {
    it('startConversation returns an id', () => {
      const id = orch.startConversation();
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('getActiveConversationId returns the started conversation', () => {
      const id = orch.startConversation();
      expect(orch.getActiveConversationId()).toBe(id);
    });

    it('getMessages returns empty array for new conversation', () => {
      orch.startConversation();
      expect(orch.getMessages()).toEqual([]);
    });

    it('getMessages returns empty array with no active conversation', () => {
      expect(orch.getMessages()).toEqual([]);
    });

    it('resumeConversation restores existing conversation', () => {
      const id = orch.startConversation();
      orch.startConversation(); // start a new one
      expect(orch.resumeConversation(id)).toBe(true);
      expect(orch.getActiveConversationId()).toBe(id);
    });

    it('resumeConversation returns false for non-existent id', () => {
      expect(orch.resumeConversation('nonexistent')).toBe(false);
    });

    it('resumeConversation emits conversation:resumed event', () => {
      const id = orch.startConversation();
      const handler = vi.fn();
      orch.on('conversation:resumed', handler);
      orch.resumeConversation(id);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'conversation:resumed',
          conversationId: id,
          messages: [],
        }),
      );
    });

    it('getConversationStore returns the store', () => {
      const store = orch.getConversationStore();
      expect(store).toBeInstanceOf(ConversationStore);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('throws without cerebrum', async () => {
      orch.startConversation();
      await expect(orch.sendMessage('hi')).rejects.toThrow('Cerebrum not connected');
    });

    it('throws without active conversation', async () => {
      orch.setCerebrum(createMockCerebrum());
      await expect(orch.sendMessage('hi')).rejects.toThrow('No active conversation');
    });

    it('emits message:user event', async () => {
      const cerebrum = createMockCerebrum();
      orch.setCerebrum(cerebrum);
      orch.startConversation();

      const handler = vi.fn();
      orch.on('message:user', handler);
      await orch.sendMessage('hello');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'message:user' }),
      );
      expect(handler.mock.calls[0][0].message.content).toBe('hello');
    });

    it('emits message:cerebrum:start and message:cerebrum:end', async () => {
      orch.setCerebrum(createMockCerebrum());
      orch.startConversation();

      const startHandler = vi.fn();
      const endHandler = vi.fn();
      orch.on('message:cerebrum:start', startHandler);
      orch.on('message:cerebrum:end', endHandler);

      await orch.sendMessage('hi');

      expect(startHandler).toHaveBeenCalledOnce();
      expect(endHandler).toHaveBeenCalledOnce();
      expect(endHandler.mock.calls[0][0].message.content).toBe('hello');
    });

    it('stores messages in conversation', async () => {
      orch.setCerebrum(createMockCerebrum());
      orch.startConversation();
      await orch.sendMessage('hi');
      const messages = orch.getMessages();
      expect(messages).toHaveLength(2); // user + cerebrum
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('cerebrum');
    });

    it('emits error event on stream failure', async () => {
      const cerebrum = createMockCerebrum();
      (cerebrum.stream as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('stream fail'));
      orch.setCerebrum(cerebrum);
      orch.startConversation();

      const handler = vi.fn();
      orch.on('error', handler);
      await orch.sendMessage('hi');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', error: expect.any(Error) }),
      );
    });
  });

  // --- Emergency stop ---

  describe('emergencyStop', () => {
    it('emits emergency:stop event', () => {
      const handler = vi.fn();
      orch.on('emergency:stop', handler);
      orch.emergencyStop();
      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not throw without sub-agent manager', () => {
      expect(() => orch.emergencyStop()).not.toThrow();
    });
  });

  // --- Fine-tuning ---

  describe('fine-tuning', () => {
    it('triggerFineTune throws without cerebellum fine-tune methods', async () => {
      orch.setCerebellum({ isConnected: () => true, verifyToolResult: vi.fn() });
      await expect(orch.triggerFineTune()).rejects.toThrow('fine-tuning not available');
    });

    it('triggerFineTune calls data provider and ingests data', async () => {
      const cerebellum = createMockCerebellum();
      orch.setCerebellum(cerebellum);

      const pairs = [{ instruction: 'q', response: 'a', source: 'test', createdAt: Date.now() }];
      orch.setFineTuneDataProvider(async () => pairs);

      await orch.triggerFineTune();

      expect(cerebellum.ingestTrainingData).toHaveBeenCalledWith(pairs);
      expect(cerebellum.startFineTune).toHaveBeenCalledWith({ method: 'auto' });
    });

    it('triggerFineTune emits finetune:start event', async () => {
      const cerebellum = createMockCerebellum();
      orch.setCerebellum(cerebellum);

      const handler = vi.fn();
      orch.on('finetune:start', handler);
      await orch.triggerFineTune();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'finetune:start', jobId: 'ft-1' }),
      );
    });

    it('triggerFineTune throws when startFineTune fails', async () => {
      const cerebellum = createMockCerebellum();
      (cerebellum.startFineTune as ReturnType<typeof vi.fn>).mockResolvedValue({
        jobId: '', started: false, error: 'GPU busy',
      });
      orch.setCerebellum(cerebellum);

      await expect(orch.triggerFineTune()).rejects.toThrow('GPU busy');
    });

    it('triggerFineTune skips ingestion when no data provider', async () => {
      const cerebellum = createMockCerebellum();
      orch.setCerebellum(cerebellum);
      // No setFineTuneDataProvider call

      await orch.triggerFineTune();

      expect(cerebellum.ingestTrainingData).not.toHaveBeenCalled();
      expect(cerebellum.startFineTune).toHaveBeenCalled();
    });

    it('setFineTuneDataProvider accepts custom method', async () => {
      const cerebellum = createMockCerebellum();
      orch.setCerebellum(cerebellum);
      orch.setFineTuneDataProvider(async () => [], 'lora');
      await orch.triggerFineTune();

      expect(cerebellum.startFineTune).toHaveBeenCalledWith({ method: 'lora' });
    });
  });

  // --- start / stop ---

  describe('start and stop', () => {
    it('start creates conversation if none active', async () => {
      orch.setCerebrum(createMockCerebrum());
      await orch.start();
      expect(orch.getActiveConversationId()).toBeTruthy();
    });

    it('stop cleans up listeners', async () => {
      const handler = vi.fn();
      orch.on('emergency:stop', handler);
      await orch.stop();
      orch.emit({ type: 'emergency:stop' });
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
