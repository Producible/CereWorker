import { describe, it, expect, vi } from 'vitest';
import { TypedEventEmitter } from './events.js';

describe('TypedEventEmitter', () => {
  it('calls handler on matching event', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('emergency:stop', handler);
    emitter.emit({ type: 'emergency:stop' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not call handler on mismatched event', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('emergency:stop', handler);
    emitter.emit({ type: 'error', error: new Error('oops') });
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple handlers on the same event type', () => {
    const emitter = new TypedEventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on('emergency:stop', h1);
    emitter.on('emergency:stop', h2);
    emitter.emit({ type: 'emergency:stop' });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('on() returns an unsubscribe function', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    const unsub = emitter.on('emergency:stop', handler);
    unsub();
    emitter.emit({ type: 'emergency:stop' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('removeAllListeners clears all handlers', () => {
    const emitter = new TypedEventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on('emergency:stop', h1);
    emitter.on('error', h2);
    emitter.removeAllListeners();
    emitter.emit({ type: 'emergency:stop' });
    emitter.emit({ type: 'error', error: new Error('x') });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('does not throw when emitting with no handlers', () => {
    const emitter = new TypedEventEmitter();
    expect(() => emitter.emit({ type: 'emergency:stop' })).not.toThrow();
  });

  it('passes full event object to handler', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('error', handler);
    const err = new Error('test');
    emitter.emit({ type: 'error', error: err });
    expect(handler).toHaveBeenCalledWith({ type: 'error', error: err });
  });

  it('passes event data for complex event types', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('node:connected', handler);
    emitter.emit({ type: 'node:connected', nodeId: 'n1', capabilities: ['shell'] });
    expect(handler).toHaveBeenCalledWith({ type: 'node:connected', nodeId: 'n1', capabilities: ['shell'] });
  });

  it('unsubscribe only removes the specific handler', () => {
    const emitter = new TypedEventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const unsub = emitter.on('emergency:stop', h1);
    emitter.on('emergency:stop', h2);
    unsub();
    emitter.emit({ type: 'emergency:stop' });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  // --- New event types (v26.314+) ---

  it('handles finetune:start event with jobId', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('finetune:start', handler);
    emitter.emit({ type: 'finetune:start', jobId: 'ft-abc' });
    expect(handler).toHaveBeenCalledWith({ type: 'finetune:start', jobId: 'ft-abc' });
  });

  it('handles finetune:progress event with progress and loss', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('finetune:progress', handler);
    emitter.emit({ type: 'finetune:progress', jobId: 'ft-1', progress: 0.42, loss: 1.23 });
    expect(handler).toHaveBeenCalledWith({ type: 'finetune:progress', jobId: 'ft-1', progress: 0.42, loss: 1.23 });
  });

  it('handles finetune:complete event with checkpoint', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('finetune:complete', handler);
    emitter.emit({ type: 'finetune:complete', jobId: 'ft-1', checkpointPath: '/checkpoints/ft-1' });
    expect(handler).toHaveBeenCalledWith({
      type: 'finetune:complete', jobId: 'ft-1', checkpointPath: '/checkpoints/ft-1',
    });
  });

  it('handles finetune:error event', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('finetune:error', handler);
    emitter.emit({ type: 'finetune:error', jobId: 'ft-1', error: 'OOM' });
    expect(handler).toHaveBeenCalledWith({ type: 'finetune:error', jobId: 'ft-1', error: 'OOM' });
  });

  it('handles conversation:resumed event with messages array', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('conversation:resumed', handler);
    const msgs = [{ id: 'm1', role: 'user' as const, content: 'hi', timestamp: 1 }];
    emitter.emit({ type: 'conversation:resumed', conversationId: 'c1', messages: msgs });
    expect(handler).toHaveBeenCalledWith({
      type: 'conversation:resumed', conversationId: 'c1', messages: msgs,
    });
  });
});
