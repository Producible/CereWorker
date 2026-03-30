import { describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from './tools.js';
import type { BrowserBackend, TabInfo } from './backend.js';

function createBackend(overrides: Partial<BrowserBackend> = {}): BrowserBackend {
  return {
    navigate: vi.fn(async (url: string) => `Navigated to ${url} - Title: Example`),
    getPageText: vi.fn(async () => 'visible text'),
    screenshot: vi.fn(async (path?: string) => `Screenshot saved to ${path ?? '/tmp/test.png'}`),
    click: vi.fn(async (selector: string) => `Clicked: ${selector}`),
    clickByText: vi.fn(async (text: string) => `Clicked element with text: "${text}"`),
    type: vi.fn(async (selector: string) => `Typed into: ${selector}`),
    evaluate: vi.fn(async () => '{"items":[{"text":"alpha"},{"text":"beta"}]}'),
    waitForSelector: vi.fn(async (selector: string) => `Found: ${selector}`),
    getPageUrl: vi.fn(async () => 'https://x.com/home'),
    listTabs: vi.fn(async () => [] as TabInfo[]),
    switchTab: vi.fn(async (tabId: string) => `Switched to tab ${tabId}: https://x.com/home`),
    newTab: vi.fn(async (url?: string) => `Opened new tab: ${url ?? 'about:blank'}`),
    closeTab: vi.fn(async () => 'Closed current tab. Now on: https://x.com/home'),
    connect: vi.fn(async () => 'Connected to Chrome via extension'),
    disconnect: vi.fn(async () => undefined),
    isConnected: vi.fn(() => true),
    ...overrides,
  };
}

describe('createBrowserTools', () => {
  it('adds structured tab details and resume metadata for browserListTabs', async () => {
    const tabs: TabInfo[] = [
      { id: '11', title: 'Home / X', url: 'https://x.com/home', active: true },
      { id: '12', title: 'Profile / X', url: 'https://x.com/CereWorkerX', active: false },
    ];
    const backend = createBackend({
      listTabs: vi.fn(async () => tabs),
    });

    const tools = createBrowserTools(backend);
    const result = await tools.browserListTabs.execute({});

    expect(result.output).toContain('→ [11] https://x.com/home - Home / X');
    expect(result.details).toEqual({ tabs });
    expect(result.metadata?.resume).toMatchObject({
      action: 'list_tabs',
      activeTabId: '11',
      url: 'https://x.com/home',
      stateChanging: false,
      tabs,
    });
  });

  it('parses JSON browserEval output into structured details', async () => {
    const backend = createBackend({
      evaluate: vi.fn(async () => '[{"i":0,"text":"hello"},{"i":1,"text":"world"}]'),
    });

    const tools = createBrowserTools(backend);
    const result = await tools.browserEval.execute({ code: 'return window.__items' });
    const resume = result.metadata?.resume as { action?: string; stateChanging?: boolean; summary?: string } | undefined;

    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({
      parsedValue: [
        { i: 0, text: 'hello' },
        { i: 1, text: 'world' },
      ],
    });
    expect(resume).toMatchObject({
      action: 'evaluate',
      stateChanging: false,
    });
    expect(String(resume?.summary)).toContain('array(2)');
  });

  it('marks click-by-text misses as errors while preserving retry metadata', async () => {
    const backend = createBackend({
      clickByText: vi.fn(async () => 'No clickable element found with text: "Like"'),
    });

    const tools = createBrowserTools(backend);
    const result = await tools.browserClickByText.execute({ text: 'Like' });
    const resume = result.metadata?.resume as { action?: string; targetText?: string; stateChanging?: boolean; summary?: string } | undefined;

    expect(result.isError).toBe(true);
    expect(resume).toMatchObject({
      action: 'click_text',
      targetText: 'Like',
      stateChanging: false,
    });
    expect(String(resume?.summary)).toContain('Failed to click text "Like"');
  });
});
