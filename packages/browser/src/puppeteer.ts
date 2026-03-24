import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { BrowserBackend, TabInfo } from './backend.js';

export interface BrowserSession {
  browser: Browser;
  page: Page;
}

export class PuppeteerBackend implements BrowserBackend {
  private session: BrowserSession | null = null;
  private headless: boolean;

  constructor(options?: { headless?: boolean }) {
    this.headless = options?.headless ?? true;
  }

  private async getSession(): Promise<BrowserSession> {
    if (this.session) return this.session;
    try {
      const browser = await puppeteer.launch({
        headless: this.headless ? 'shell' : false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      this.session = { browser, page };
      return this.session;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `No browser available (${msg}). ` +
        'Use httpFetch/shell tools for API calls, or install Chrome for browser automation.',
      );
    }
  }

  async navigate(url: string): Promise<string> {
    const s = await this.getSession();
    await s.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    return `Navigated to ${s.page.url()} - Title: ${await s.page.title()}`;
  }

  async getPageText(): Promise<string> {
    const s = await this.getSession();
    const text = await s.page.evaluate(() => document.body.innerText);
    const maxLen = 10000;
    return text.length > maxLen ? text.slice(0, maxLen) + '\n... (truncated)' : text;
  }

  async screenshot(path?: string): Promise<string> {
    const s = await this.getSession();
    const filePath = path ?? `/tmp/cereworker-screenshot-${Date.now()}.png`;
    await s.page.screenshot({ path: filePath, fullPage: false });
    return `Screenshot saved to ${filePath}`;
  }

  async click(selector: string): Promise<string> {
    const s = await this.getSession();
    try {
      await s.page.click(selector);
      return `Clicked: ${selector}`;
    } catch {
      return `Element not found: ${selector}`;
    }
  }

  async type(selector: string, text: string): Promise<string> {
    const s = await this.getSession();
    try {
      await s.page.type(selector, text);
      return `Typed into: ${selector}`;
    } catch {
      return `Element not found: ${selector}`;
    }
  }

  async evaluate(code: string): Promise<string> {
    const s = await this.getSession();
    try {
      const result = await s.page.evaluate(code);
      return String(result ?? '(no result)');
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async waitForSelector(selector: string, timeoutMs = 5000): Promise<string> {
    const s = await this.getSession();
    try {
      await s.page.waitForSelector(selector, { timeout: timeoutMs });
      return `Found: ${selector}`;
    } catch {
      return `Timeout waiting for: ${selector}`;
    }
  }

  async getPageUrl(): Promise<string> {
    const s = await this.getSession();
    return s.page.url();
  }

  async listTabs(): Promise<TabInfo[]> {
    const s = await this.getSession();
    const pages = await s.browser.pages();
    return pages.map((p, i) => ({
      id: String(i),
      title: '',  // title() is async, keep lightweight
      url: p.url(),
      active: p === s.page,
    }));
  }

  async switchTab(tabId: string): Promise<string> {
    const s = await this.getSession();
    const pages = await s.browser.pages();
    const idx = parseInt(tabId, 10);
    if (isNaN(idx) || idx < 0 || idx >= pages.length) {
      return `Invalid tab id: ${tabId}. Use browserListTabs to see available tabs.`;
    }
    s.page = pages[idx];
    this.session = s;
    await s.page.bringToFront();
    return `Switched to tab ${idx}: ${s.page.url()}`;
  }

  async newTab(url?: string): Promise<string> {
    const s = await this.getSession();
    const page = await s.browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    if (url) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    }
    s.page = page;
    this.session = s;
    const pages = await s.browser.pages();
    return `Opened new tab (${pages.length} total)${url ? `: ${page.url()}` : ''}`;
  }

  async closeTab(tabId?: string): Promise<string> {
    const s = await this.getSession();
    const pages = await s.browser.pages();
    if (pages.length <= 1) return 'Cannot close the last tab.';

    if (tabId !== undefined) {
      const idx = parseInt(tabId, 10);
      if (isNaN(idx) || idx < 0 || idx >= pages.length) {
        return `Invalid tab id: ${tabId}`;
      }
      await pages[idx].close();
      if (pages[idx] === s.page) {
        const remaining = await s.browser.pages();
        s.page = remaining[remaining.length - 1];
        this.session = s;
      }
      return `Closed tab ${idx}`;
    }

    // Close current tab
    const current = s.page;
    await current.close();
    const remaining = await s.browser.pages();
    s.page = remaining[remaining.length - 1];
    this.session = s;
    return `Closed current tab. Now on: ${s.page.url()}`;
  }

  async connect(): Promise<string> {
    const s = await this.getSession();
    return `Browser launched (headless: ${this.headless}). Page: ${s.page.url()}`;
  }

  async disconnect(): Promise<void> {
    if (this.session) {
      await this.session.browser.close();
      this.session = null;
    }
  }

  isConnected(): boolean {
    return this.session !== null && this.session.browser.connected;
  }
}
