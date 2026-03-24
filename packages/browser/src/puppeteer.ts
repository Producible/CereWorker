import puppeteer, { type Browser, type Page } from 'puppeteer';
import { connectCdp, disconnectCdp, getCdpSession, type CdpConnectionOptions } from './cdp.js';

export interface BrowserSession {
  browser: Browser;
  page: Page;
}

let session: BrowserSession | null = null;
let mode: 'launch' | 'connect' = 'launch';
let cdpOptions: CdpConnectionOptions = {};

export function setMode(m: 'launch' | 'connect', options?: CdpConnectionOptions): void {
  mode = m;
  cdpOptions = options ?? {};
}

export function getMode(): 'launch' | 'connect' {
  return mode;
}

async function getOrCreateSession(): Promise<BrowserSession> {
  try {
    if (mode === 'connect') {
      const existing = getCdpSession();
      if (existing) return existing;
      return await connectCdp(cdpOptions);
    }
    return await launchBrowser();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `No browser available (${msg}). ` +
      'Either launch Chrome with --remote-debugging-port and use browserConnect, ' +
      'or use httpFetch/shell tools instead of browser automation.',
    );
  }
}

export async function launchBrowser(headless = true): Promise<BrowserSession> {
  if (session) return session;

  const browser = await puppeteer.launch({
    headless: headless ? 'shell' : false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  session = { browser, page };
  return session;
}

export async function closeBrowser(): Promise<void> {
  if (mode === 'connect') {
    await disconnectCdp();
    return;
  }
  if (session) {
    await session.browser.close();
    session = null;
  }
}

export function getSession(): BrowserSession | null {
  if (mode === 'connect') return getCdpSession();
  return session;
}

export async function navigateTo(url: string): Promise<string> {
  const s = await getOrCreateSession();
  await s.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  return `Navigated to ${s.page.url()} - Title: ${await s.page.title()}`;
}

export async function getPageText(): Promise<string> {
  const s = await getOrCreateSession();
  const text = await s.page.evaluate(() => document.body.innerText);
  // Truncate to avoid massive output
  const maxLen = 10000;
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + '\n... (truncated)';
  }
  return text;
}

export async function screenshot(path?: string): Promise<string> {
  const s = await getOrCreateSession();
  const filePath = path ?? `/tmp/cereworker-screenshot-${Date.now()}.png`;
  await s.page.screenshot({ path: filePath, fullPage: false });
  return `Screenshot saved to ${filePath}`;
}

export async function clickElement(selector: string): Promise<string> {
  const s = await getOrCreateSession();
  try {
    await s.page.click(selector);
    return `Clicked: ${selector}`;
  } catch {
    return `Element not found: ${selector}`;
  }
}

export async function typeText(selector: string, text: string): Promise<string> {
  const s = await getOrCreateSession();
  try {
    await s.page.type(selector, text);
    return `Typed into: ${selector}`;
  } catch {
    return `Element not found: ${selector}`;
  }
}

export async function evaluateJs(code: string): Promise<string> {
  const s = await getOrCreateSession();
  try {
    const result = await s.page.evaluate(code);
    return String(result ?? '(no result)');
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function waitForSelector(selector: string, timeoutMs = 5000): Promise<string> {
  const s = await getOrCreateSession();
  try {
    await s.page.waitForSelector(selector, { timeout: timeoutMs });
    return `Found: ${selector}`;
  } catch {
    return `Timeout waiting for: ${selector}`;
  }
}

export async function getPageUrl(): Promise<string> {
  const s = await getOrCreateSession();
  return s.page.url();
}
