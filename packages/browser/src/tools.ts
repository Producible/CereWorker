import type { ToolExecutionValue } from '@cereworker/core';
import { z } from 'zod';
import type { BrowserBackend, TabInfo } from './backend.js';

type ToolContext = { abortSignal?: AbortSignal };

interface BrowserResumeMetadata {
  action: string;
  summary: string;
  url?: string;
  tabId?: string;
  activeTabId?: string;
  tabs?: TabInfo[];
  targetText?: string;
  targetSelector?: string;
  stateChanging: boolean;
}

interface BrowserToolResultOptions {
  details?: Record<string, unknown>;
  resume: BrowserResumeMetadata;
  isError?: boolean;
}

function wrap<T>(
  fn: (args: T, context?: ToolContext) => Promise<string>,
  build: (args: T, output: string, isError: boolean) => ToolExecutionValue | Promise<ToolExecutionValue>,
): (args: T, context?: ToolContext) => Promise<ToolExecutionValue> {
  return async (args: T, context?: ToolContext) => {
    try {
      const output = await fn(args, context);
      return build(args, output, browserOutputLooksLikeError(output));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      const output = err instanceof Error ? err.message : String(err);
      return build(args, output, true);
    }
  };
}

function createBrowserToolResult(
  output: string,
  options: BrowserToolResultOptions,
): ToolExecutionValue {
  return {
    output,
    isError: options.isError ?? false,
    ...(options.details ? { details: options.details } : {}),
    metadata: {
      resume: options.resume,
    },
  };
}

function browserOutputLooksLikeError(output: string): boolean {
  const trimmed = output.trim();
  return [
    /^Error:/i,
    /^Element not found:/i,
    /^No clickable element found/i,
    /^Invalid tab id:/i,
    /^Timeout waiting for:/i,
    /^Cannot close the last tab\./i,
    /^Chrome extension not connected/i,
    /^Extension not connected/i,
    /^Command .* timed out/i,
    /^Directory not found:/i,
  ].some((pattern) => pattern.test(trimmed));
}

function truncate(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function compactWhitespace(text: string): string {
  return truncate(text, 220).replace(/\s+/g, ' ').trim();
}

function summarizeReadText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return 'Read page text (empty page text).';
  const excerpt = truncate(normalized.replace(/\s+/g, ' '), 180);
  return `Read page text: ${excerpt}`;
}

function summarizeTypedText(text: string): string {
  const preview = truncate(text.replace(/\s+/g, ' '), 120);
  return preview ? `Typed text "${preview}"` : 'Typed text.';
}

function summarizeStructuredValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(${value.length}): ${truncate(JSON.stringify(value), 180)}`;
  }
  if (value && typeof value === 'object') {
    return `object: ${truncate(JSON.stringify(value), 180)}`;
  }
  return truncate(String(value), 180);
}

function tryParseJson(output: string): unknown | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed === 'null' || trimmed === 'true' || trimmed === 'false' || /^-?\d/.test(trimmed))) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function inferOpaqueEvalSummary(output: string): string {
  if (output.includes('[object Object]')) {
    return 'Evaluated browser code -> opaque object result.';
  }
  return `Evaluated browser code -> ${compactWhitespace(output)}`;
}

function formatTabsOutput(tabs: TabInfo[]): string {
  if (tabs.length === 0) return 'No tabs open.';
  return tabs.map((tab) =>
    `${tab.active ? '→ ' : '  '}[${tab.id}] ${tab.url}${tab.title ? ` - ${tab.title}` : ''}`,
  ).join('\n');
}

function summarizeTabs(tabs: TabInfo[]): string {
  if (tabs.length === 0) return 'Listed tabs: no tabs open.';
  const active = tabs.find((tab) => tab.active);
  if (active) {
    return `Listed ${tabs.length} tab(s); active tab ${active.id}: ${active.url}`;
  }
  return `Listed ${tabs.length} tab(s).`;
}

function parseNavigateOutput(output: string): { url?: string; title?: string } {
  const match = output.match(/^Navigated to (.+?) - Title: (.+)$/);
  if (match) {
    return { url: match[1], title: match[2] };
  }
  return {};
}

function parseSwitchTabOutput(output: string): { tabId?: string; url?: string } {
  const match = output.match(/^Switched to tab ([^:]+): (.+)$/);
  if (match) {
    return { tabId: match[1], url: match[2] };
  }
  return {};
}

function parseNewTabOutput(output: string): { url?: string } {
  const direct = output.match(/^Opened new tab: (.+)$/);
  if (direct) return { url: direct[1] };
  const counted = output.match(/^Opened new tab \(\d+ total\)(?:: (.+))?$/);
  if (counted) return { url: counted[1] };
  return {};
}

function parseCloseTabOutput(output: string): { url?: string } {
  const match = output.match(/^Closed current tab\. Now on: (.+)$/);
  if (match) return { url: match[1] };
  return {};
}

export function createBrowserTools(backend: BrowserBackend) {
  return {
    browserNavigate: {
      description: 'Navigate the browser to a URL. Prefer httpFetch for API calls.',
      parameters: z.object({
        url: z.string().describe('The URL to navigate to'),
      }),
      execute: wrap(
        (args: { url: string }, context) => backend.navigate(args.url, { abortSignal: context?.abortSignal }),
        (args, output, isError) => {
          const parsed = parseNavigateOutput(output);
          return createBrowserToolResult(output, {
            isError,
            resume: {
              action: 'navigate',
              summary: compactWhitespace(output),
              url: parsed.url ?? args.url,
              stateChanging: true,
            },
            details: {
              requestedUrl: args.url,
              actualUrl: parsed.url ?? args.url,
              title: parsed.title,
            },
          });
        },
      ),
    },
    browserGetText: {
      description: 'Get the visible text content of the current page',
      parameters: z.object({}),
      execute: wrap(
        async (_args: Record<string, never>, context) => backend.getPageText({ abortSignal: context?.abortSignal }),
        (_args, output, isError) => createBrowserToolResult(output, {
          isError,
          resume: {
            action: 'read_page_text',
            summary: summarizeReadText(output),
            stateChanging: false,
          },
          details: {
            textLength: output.length,
            excerpt: truncate(output, 500),
          },
        }),
      ),
    },
    browserScreenshot: {
      description: 'Take a screenshot of the current page',
      parameters: z.object({
        path: z.string().optional().describe('File path to save screenshot'),
      }),
      execute: wrap(
        async (args: { path?: string }, context) => backend.screenshot(args.path, { abortSignal: context?.abortSignal }),
        (args, output, isError) => createBrowserToolResult(output, {
          isError,
          resume: {
            action: 'screenshot',
            summary: compactWhitespace(output),
            stateChanging: false,
          },
          details: {
            requestedPath: args.path,
          },
        }),
      ),
    },
    browserClick: {
      description: 'Click an element on the page by CSS selector. Uses full mouse event sequence for React/SPA compatibility.',
      parameters: z.object({
        selector: z.string().describe('CSS selector of the element to click'),
      }),
      execute: wrap(
        async (args: { selector: string }, context) => backend.click(args.selector, { abortSignal: context?.abortSignal }),
        (args, output, isError) => createBrowserToolResult(output, {
          isError,
          resume: {
            action: 'click',
            summary: isError
              ? `Failed to click selector ${args.selector}: ${compactWhitespace(output)}`
              : `Clicked selector ${args.selector}: ${compactWhitespace(output)}`,
            targetSelector: args.selector,
            stateChanging: !isError,
          },
          details: {
            selector: args.selector,
          },
        }),
      ),
    },
    browserClickByText: {
      description: 'Click a button or link by its visible text. More reliable than CSS selectors for dynamic SPAs like X/Twitter. Optionally filter by ARIA role.',
      parameters: z.object({
        text: z.string().describe('Exact visible text of the element to click (e.g. "Next", "Post", "Log in")'),
        role: z.string().optional().describe('Optional ARIA role filter (e.g. "button")'),
      }),
      execute: wrap(
        async (args: { text: string; role?: string }, context) => backend.clickByText(args.text, args.role, { abortSignal: context?.abortSignal }),
        (args, output, isError) => createBrowserToolResult(output, {
          isError,
          resume: {
            action: 'click_text',
            summary: isError
              ? `Failed to click text "${args.text}"${args.role ? ` (${args.role})` : ''}: ${compactWhitespace(output)}`
              : `Clicked text "${args.text}"${args.role ? ` (${args.role})` : ''}: ${compactWhitespace(output)}`,
            targetText: args.text,
            stateChanging: !isError,
          },
          details: {
            text: args.text,
            role: args.role,
          },
        }),
      ),
    },
    browserType: {
      description: 'Type text into an input element on the page',
      parameters: z.object({
        selector: z.string().describe('CSS selector of the input element'),
        text: z.string().describe('Text to type'),
      }),
      execute: wrap(
        async (args: { selector: string; text: string }, context) => backend.type(args.selector, args.text, { abortSignal: context?.abortSignal }),
        (args, output, isError) => createBrowserToolResult(output, {
          isError,
          resume: {
            action: 'type',
            summary: isError
              ? `Failed to type into ${args.selector}: ${compactWhitespace(output)}`
              : `${summarizeTypedText(args.text)} into ${args.selector}.`,
            targetSelector: args.selector,
            stateChanging: !isError,
          },
          details: {
            selector: args.selector,
            typedTextPreview: truncate(args.text, 500),
          },
        }),
      ),
    },
    browserEval: {
      description: 'Execute JavaScript code in the browser page context',
      parameters: z.object({
        code: z.string().describe('JavaScript code to evaluate'),
      }),
      execute: wrap(
        async (args: { code: string }, context) => backend.evaluate(args.code, { abortSignal: context?.abortSignal }),
        (args, output, isError) => {
          const parsedValue = tryParseJson(output);
          return createBrowserToolResult(output, {
            isError,
            resume: {
              action: 'evaluate',
              summary: parsedValue !== null
                ? `Evaluated browser code -> ${summarizeStructuredValue(parsedValue)}`
                : inferOpaqueEvalSummary(output),
              stateChanging: false,
            },
            details: {
              codePreview: truncate(args.code, 300),
              ...(parsedValue !== null ? { parsedValue } : {}),
            },
          });
        },
      ),
    },
    browserWait: {
      description: 'Wait for a CSS selector to appear on the page',
      parameters: z.object({
        selector: z.string().describe('CSS selector to wait for'),
        timeout: z.number().optional().default(5000).describe('Timeout in milliseconds'),
      }),
      execute: wrap(
        async (args: { selector: string; timeout?: number }, context) =>
          backend.waitForSelector(args.selector, args.timeout, { abortSignal: context?.abortSignal }),
        (args, output, isError) => createBrowserToolResult(output, {
          isError,
          resume: {
            action: 'wait_for_selector',
            summary: compactWhitespace(output),
            targetSelector: args.selector,
            stateChanging: false,
          },
          details: {
            selector: args.selector,
            timeoutMs: args.timeout ?? 5000,
          },
        }),
      ),
    },
    browserGetUrl: {
      description: 'Get the current URL of the browser page',
      parameters: z.object({}),
      execute: wrap(
        async (_args: Record<string, never>, context) => backend.getPageUrl({ abortSignal: context?.abortSignal }),
        (_args, output, isError) => createBrowserToolResult(output, {
          isError,
          resume: {
            action: 'get_url',
            summary: `Current URL: ${compactWhitespace(output)}`,
            url: output.trim(),
            stateChanging: false,
          },
        }),
      ),
    },
    browserListTabs: {
      description: 'List all open browser tabs with their URLs',
      parameters: z.object({}),
      execute: async (_args: Record<string, never>, context?: ToolContext) => {
        try {
          const tabs = await backend.listTabs({ abortSignal: context?.abortSignal });
          const active = tabs.find((tab) => tab.active);
          return createBrowserToolResult(formatTabsOutput(tabs), {
            isError: false,
            resume: {
              action: 'list_tabs',
              summary: summarizeTabs(tabs),
              url: active?.url,
              activeTabId: active?.id,
              tabs,
              stateChanging: false,
            },
            details: {
              tabs,
            },
          });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            throw err;
          }
          const output = err instanceof Error ? err.message : String(err);
          return createBrowserToolResult(output, {
            isError: true,
            resume: {
              action: 'list_tabs',
              summary: compactWhitespace(output),
              stateChanging: false,
            },
          });
        }
      },
    },
    browserSwitchTab: {
      description: 'Switch to a different browser tab by its ID',
      parameters: z.object({
        tabId: z.string().describe('Tab ID from browserListTabs'),
      }),
      execute: wrap(
        async (args: { tabId: string }, context) => backend.switchTab(args.tabId, { abortSignal: context?.abortSignal }),
        (args, output, isError) => {
          const parsed = parseSwitchTabOutput(output);
          return createBrowserToolResult(output, {
            isError,
            resume: {
              action: 'switch_tab',
              summary: compactWhitespace(output),
              url: parsed.url,
              tabId: parsed.tabId ?? args.tabId,
              activeTabId: parsed.tabId ?? args.tabId,
              stateChanging: !isError,
            },
            details: {
              requestedTabId: args.tabId,
            },
          });
        },
      ),
    },
    browserNewTab: {
      description: 'Open a new browser tab, optionally navigating to a URL',
      parameters: z.object({
        url: z.string().optional().describe('URL to navigate to in the new tab'),
      }),
      execute: wrap(
        async (args: { url?: string }, context) => backend.newTab(args.url, { abortSignal: context?.abortSignal }),
        (args, output, isError) => {
          const parsed = parseNewTabOutput(output);
          return createBrowserToolResult(output, {
            isError,
            resume: {
              action: 'new_tab',
              summary: compactWhitespace(output),
              url: parsed.url ?? args.url,
              stateChanging: !isError,
            },
            details: {
              requestedUrl: args.url,
              actualUrl: parsed.url ?? args.url,
            },
          });
        },
      ),
    },
    browserCloseTab: {
      description: 'Close a browser tab by ID, or close the current tab',
      parameters: z.object({
        tabId: z.string().optional().describe('Tab ID to close (current tab if omitted)'),
      }),
      execute: wrap(
        async (args: { tabId?: string }, context) => backend.closeTab(args.tabId, { abortSignal: context?.abortSignal }),
        (args, output, isError) => {
          const parsed = parseCloseTabOutput(output);
          return createBrowserToolResult(output, {
            isError,
            resume: {
              action: 'close_tab',
              summary: compactWhitespace(output),
              url: parsed.url,
              tabId: args.tabId,
              stateChanging: !isError,
            },
            details: {
              requestedTabId: args.tabId,
            },
          });
        },
      ),
    },
    browserConnect: {
      description: 'Connect to the browser backend. In extension mode, waits for the Chrome extension.',
      parameters: z.object({}),
      execute: wrap(
        async (_args: Record<string, never>, context) => backend.connect({ abortSignal: context?.abortSignal }),
        (_args, output, isError) => createBrowserToolResult(output, {
          isError,
          resume: {
            action: 'connect_browser',
            summary: compactWhitespace(output),
            stateChanging: !isError,
          },
        }),
      ),
    },
    browserDisconnect: {
      description: 'Disconnect from the browser without closing it',
      parameters: z.object({}),
      execute: wrap(
        async () => {
          await backend.disconnect();
          return 'Disconnected from browser';
        },
        (_args, output, isError) => createBrowserToolResult(output, {
          isError,
          resume: {
            action: 'disconnect_browser',
            summary: compactWhitespace(output),
            stateChanging: !isError,
          },
        }),
      ),
    },
  };
}

export type BrowserTools = ReturnType<typeof createBrowserTools>;
export type BrowserToolName = keyof BrowserTools;
