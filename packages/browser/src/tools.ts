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
} from './puppeteer.js';

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
  browserClose: {
    description: 'Close the browser',
    parameters: z.object({}),
    execute: async () => {
      await closeBrowser();
      return 'Browser closed';
    },
  },
};

export type BrowserToolName = keyof typeof browserToolDefinitions;
