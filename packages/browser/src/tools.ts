import { z } from 'zod';
import type { BrowserBackend } from './backend.js';

function wrap<T>(fn: (args: T) => Promise<string>): (args: T) => Promise<string> {
  return async (args: T) => {
    try {
      return await fn(args);
    } catch (err) {
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
      execute: wrap((args: { url: string }) => backend.navigate(args.url)),
    },
    browserGetText: {
      description: 'Get the visible text content of the current page',
      parameters: z.object({}),
      execute: wrap(async () => backend.getPageText()),
    },
    browserScreenshot: {
      description: 'Take a screenshot of the current page',
      parameters: z.object({
        path: z.string().optional().describe('File path to save screenshot'),
      }),
      execute: wrap(async (args: { path?: string }) => backend.screenshot(args.path)),
    },
    browserClick: {
      description: 'Click an element on the page by CSS selector',
      parameters: z.object({
        selector: z.string().describe('CSS selector of the element to click'),
      }),
      execute: wrap(async (args: { selector: string }) => backend.click(args.selector)),
    },
    browserType: {
      description: 'Type text into an input element on the page',
      parameters: z.object({
        selector: z.string().describe('CSS selector of the input element'),
        text: z.string().describe('Text to type'),
      }),
      execute: wrap(async (args: { selector: string; text: string }) => backend.type(args.selector, args.text)),
    },
    browserEval: {
      description: 'Execute JavaScript code in the browser page context',
      parameters: z.object({
        code: z.string().describe('JavaScript code to evaluate'),
      }),
      execute: wrap(async (args: { code: string }) => backend.evaluate(args.code)),
    },
    browserWait: {
      description: 'Wait for a CSS selector to appear on the page',
      parameters: z.object({
        selector: z.string().describe('CSS selector to wait for'),
        timeout: z.number().optional().default(5000).describe('Timeout in milliseconds'),
      }),
      execute: wrap(async (args: { selector: string; timeout?: number }) =>
        backend.waitForSelector(args.selector, args.timeout)),
    },
    browserGetUrl: {
      description: 'Get the current URL of the browser page',
      parameters: z.object({}),
      execute: wrap(async () => backend.getPageUrl()),
    },
    browserListTabs: {
      description: 'List all open browser tabs with their URLs',
      parameters: z.object({}),
      execute: wrap(async () => {
        const tabs = await backend.listTabs();
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
      execute: wrap(async (args: { tabId: string }) => backend.switchTab(args.tabId)),
    },
    browserNewTab: {
      description: 'Open a new browser tab, optionally navigating to a URL',
      parameters: z.object({
        url: z.string().optional().describe('URL to navigate to in the new tab'),
      }),
      execute: wrap(async (args: { url?: string }) => backend.newTab(args.url)),
    },
    browserCloseTab: {
      description: 'Close a browser tab by ID, or close the current tab',
      parameters: z.object({
        tabId: z.string().optional().describe('Tab ID to close (current tab if omitted)'),
      }),
      execute: wrap(async (args: { tabId?: string }) => backend.closeTab(args.tabId)),
    },
    browserConnect: {
      description: 'Connect to the browser backend. In extension mode, waits for the Chrome extension.',
      parameters: z.object({}),
      execute: wrap(async () => backend.connect()),
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
