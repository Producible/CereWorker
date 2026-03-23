import puppeteer from 'puppeteer';
import type { BrowserSession } from './puppeteer.js';

export interface CdpConnectionOptions {
  /** Chrome remote debugging port (default: 9222) */
  port?: number;
  /** Direct WebSocket endpoint URL */
  wsEndpoint?: string;
}

let cdpSession: BrowserSession | null = null;

export async function connectCdp(options: CdpConnectionOptions = {}): Promise<BrowserSession> {
  if (cdpSession) return cdpSession;

  let wsEndpoint = options.wsEndpoint;

  if (!wsEndpoint) {
    const port = options.port ?? 9222;
    const response = await fetch(`http://localhost:${port}/json/version`);
    const data = (await response.json()) as { webSocketDebuggerUrl: string };
    wsEndpoint = data.webSocketDebuggerUrl;
  }

  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());

  cdpSession = { browser, page };
  return cdpSession;
}

export async function disconnectCdp(): Promise<void> {
  if (cdpSession) {
    cdpSession.browser.disconnect();
    cdpSession = null;
  }
}

export function getCdpSession(): BrowserSession | null {
  return cdpSession;
}
