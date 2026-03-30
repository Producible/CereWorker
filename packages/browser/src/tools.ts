import { z } from 'zod';
import type { BrowserBackend } from './backend.js';

function wrap<T>(
  fn: (args: T, context?: { abortSignal?: AbortSignal }) => Promise<string>,
): (args: T, context?: { abortSignal?: AbortSignal }) => Promise<string> {
  return async (args: T, context?: { abortSignal?: AbortSignal }) => {
    try {
      return await fn(args, context);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      return err instanceof Error ? err.message : String(err);
    }
  };
}

export function createBrowserTools(backend: BrowserBackend) {
  return {
    browserNavigate: {
      description: 'Navigate the browser to a URL. Prefer httpFetch for API calls.',
      parameters: z.object({
        url: z.string().describe('The URL to navigate to'),
      }),
      execute: wrap((args: { url: string }, context) => backend.navigate(args.url, { abortSignal: context?.abortSignal })),
    },
    browserGetText: {
      description: 'Get the visible text content of the current page',
      parameters: z.object({}),
      execute: wrap(async (_args: Record<string, never>, context) => backend.getPageText({ abortSignal: context?.abortSignal })),
    },
    browserScreenshot: {
      description: 'Take a screenshot of the current page',
      parameters: z.object({
        path: z.string().optional().describe('File path to save screenshot'),
      }),
      execute: wrap(async (args: { path?: string }, context) => backend.screenshot(args.path, { abortSignal: context?.abortSignal })),
    },
    browserClick: {
      description: 'Click an element on the page by CSS selector. Uses full mouse event sequence for React/SPA compatibility.',
      parameters: z.object({
        selector: z.string().describe('CSS selector of the element to click'),
      }),
      execute: wrap(async (args: { selector: string }, context) => backend.click(args.selector, { abortSignal: context?.abortSignal })),
    },
    browserClickByText: {
      description: 'Click a button or link by its visible text. More reliable than CSS selectors for dynamic SPAs like X/Twitter. Optionally filter by ARIA role.',
      parameters: z.object({
        text: z.string().describe('Exact visible text of the element to click (e.g. "Next", "Post", "Log in")'),
        role: z.string().optional().describe('Optional ARIA role filter (e.g. "button")'),
      }),
      execute: wrap(async (args: { text: string; role?: string }, context) => backend.clickByText(args.text, args.role, { abortSignal: context?.abortSignal })),
    },
    browserType: {
      description: 'Type text into an input element on the page',
      parameters: z.object({
        selector: z.string().describe('CSS selector of the input element'),
        text: z.string().describe('Text to type'),
      }),
      execute: wrap(async (args: { selector: string; text: string }, context) => backend.type(args.selector, args.text, { abortSignal: context?.abortSignal })),
    },
    browserEval: {
      description: 'Execute JavaScript code in the browser page context',
      parameters: z.object({
        code: z.string().describe('JavaScript code to evaluate'),
      }),
      execute: wrap(async (args: { code: string }, context) => backend.evaluate(args.code, { abortSignal: context?.abortSignal })),
    },
    browserWait: {
      description: 'Wait for a CSS selector to appear on the page',
      parameters: z.object({
        selector: z.string().describe('CSS selector to wait for'),
        timeout: z.number().optional().default(5000).describe('Timeout in milliseconds'),
      }),
      execute: wrap(async (args: { selector: string; timeout?: number }, context) =>
        backend.waitForSelector(args.selector, args.timeout, { abortSignal: context?.abortSignal })),
    },
    browserGetUrl: {
      description: 'Get the current URL of the browser page',
      parameters: z.object({}),
      execute: wrap(async (_args: Record<string, never>, context) => backend.getPageUrl({ abortSignal: context?.abortSignal })),
    },
    browserListTabs: {
      description: 'List all open browser tabs with their URLs',
      parameters: z.object({}),
      execute: wrap(async (_args: Record<string, never>, context) => {
        const tabs = await backend.listTabs({ abortSignal: context?.abortSignal });
        if (tabs.length === 0) return 'No tabs open.';
        return tabs.map((t) =>
          `${t.active ? '→ ' : '  '}[${t.id}] ${t.url}${t.title ? ` - ${t.title}` : ''}`
        ).join('\n');
      }),
    },
    browserSwitchTab: {
      description: 'Switch to a different browser tab by its ID',
      parameters: z.object({
        tabId: z.string().describe('Tab ID from browserListTabs'),
      }),
      execute: wrap(async (args: { tabId: string }, context) => backend.switchTab(args.tabId, { abortSignal: context?.abortSignal })),
    },
    browserNewTab: {
      description: 'Open a new browser tab, optionally navigating to a URL',
      parameters: z.object({
        url: z.string().optional().describe('URL to navigate to in the new tab'),
      }),
      execute: wrap(async (args: { url?: string }, context) => backend.newTab(args.url, { abortSignal: context?.abortSignal })),
    },
    browserCloseTab: {
      description: 'Close a browser tab by ID, or close the current tab',
      parameters: z.object({
        tabId: z.string().optional().describe('Tab ID to close (current tab if omitted)'),
      }),
      execute: wrap(async (args: { tabId?: string }, context) => backend.closeTab(args.tabId, { abortSignal: context?.abortSignal })),
    },
    browserConnect: {
      description: 'Connect to the browser backend. In extension mode, waits for the Chrome extension.',
      parameters: z.object({}),
      execute: wrap(async (_args: Record<string, never>, context) => backend.connect({ abortSignal: context?.abortSignal })),
    },
    browserDisconnect: {
      description: 'Disconnect from the browser without closing it',
      parameters: z.object({}),
      execute: wrap(async () => {
        await backend.disconnect();
        return 'Disconnected from browser';
      }),
    },
  };
}

export type BrowserTools = ReturnType<typeof createBrowserTools>;
export type BrowserToolName = keyof BrowserTools;
