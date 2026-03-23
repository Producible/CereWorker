import { z } from 'zod';
import {
  navigateTo,
  getPageText,
  screenshot,
  clickElement,
  typeText,
  evaluateJs,
  waitForSelector,
  getPageUrl,
  closeBrowser,
  setMode,
  getMode,
} from './puppeteer.js';
import { connectCdp, disconnectCdp } from './cdp.js';

export const browserToolDefinitions = {
  browserNavigate: {
    description: 'Navigate the browser to a URL',
    parameters: z.object({
      url: z.string().describe('The URL to navigate to'),
    }),
    execute: async (args: { url: string }) => navigateTo(args.url),
  },
  browserGetText: {
    description: 'Get the visible text content of the current page',
    parameters: z.object({}),
    execute: async () => getPageText(),
  },
  browserScreenshot: {
    description: 'Take a screenshot of the current page',
    parameters: z.object({
      path: z.string().optional().describe('File path to save screenshot'),
    }),
    execute: async (args: { path?: string }) => screenshot(args.path),
  },
  browserClick: {
    description: 'Click an element on the page by CSS selector',
    parameters: z.object({
      selector: z.string().describe('CSS selector of the element to click'),
    }),
    execute: async (args: { selector: string }) => clickElement(args.selector),
  },
  browserType: {
    description: 'Type text into an input element on the page',
    parameters: z.object({
      selector: z.string().describe('CSS selector of the input element'),
      text: z.string().describe('Text to type'),
    }),
    execute: async (args: { selector: string; text: string }) => typeText(args.selector, args.text),
  },
  browserEval: {
    description: 'Execute JavaScript code in the browser page context',
    parameters: z.object({
      code: z.string().describe('JavaScript code to evaluate'),
    }),
    execute: async (args: { code: string }) => evaluateJs(args.code),
  },
  browserWait: {
    description: 'Wait for a CSS selector to appear on the page',
    parameters: z.object({
      selector: z.string().describe('CSS selector to wait for'),
      timeout: z.number().optional().default(5000).describe('Timeout in milliseconds'),
    }),
    execute: async (args: { selector: string; timeout?: number }) =>
      waitForSelector(args.selector, args.timeout),
  },
  browserGetUrl: {
    description: 'Get the current URL of the browser page',
    parameters: z.object({}),
    execute: async () => getPageUrl(),
  },
  browserConnect: {
    description:
      'Connect to an existing Chrome browser via CDP (Chrome DevTools Protocol). Chrome must be running with --remote-debugging-port.',
    parameters: z.object({
      port: z.number().optional().default(9222).describe('Chrome remote debugging port'),
      wsEndpoint: z.string().optional().describe('Direct WebSocket endpoint URL (overrides port)'),
    }),
    execute: async (args: { port?: number; wsEndpoint?: string }) => {
      try {
        setMode('connect', { port: args.port, wsEndpoint: args.wsEndpoint });
        const s = await connectCdp({ port: args.port, wsEndpoint: args.wsEndpoint });
        const url = s.page.url();
        return `Connected to Chrome via CDP. Current page: ${url}`;
      } catch (err) {
        setMode('launch');
        return `Failed to connect: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  browserDisconnect: {
    description: 'Disconnect from Chrome without closing it (CDP mode only)',
    parameters: z.object({}),
    execute: async () => {
      if (getMode() !== 'connect') {
        return 'Not in CDP mode. Use browserClose to close a launched browser.';
      }
      await disconnectCdp();
      setMode('launch');
      return 'Disconnected from Chrome';
    },
  },
  browserClose: {
    description: 'Close the browser (launch mode) or disconnect (CDP mode)',
    parameters: z.object({}),
    execute: async () => {
      await closeBrowser();
      return getMode() === 'connect' ? 'Disconnected from Chrome' : 'Browser closed';
    },
  },
};

export type BrowserToolName = keyof typeof browserToolDefinitions;
