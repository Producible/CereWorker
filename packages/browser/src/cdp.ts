import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { BrowserBackend, BrowserCommandOptions, TabInfo } from './backend.js';

export interface CdpConnectionOptions {
  port?: number;
  wsEndpoint?: string;
}

export class CdpBackend implements BrowserBackend {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private options: CdpConnectionOptions;

  constructor(options?: CdpConnectionOptions) {
    this.options = options ?? {};
  }

  private async ensureConnected(): Promise<{ browser: Browser; page: Page }> {
    if (this.browser && this.page) return { browser: this.browser, page: this.page };
    try {
      let wsEndpoint = this.options.wsEndpoint;
      if (!wsEndpoint) {
        const port = this.options.port ?? 9222;
        const response = await fetch(`http://localhost:${port}/json/version`);
        const data = (await response.json()) as { webSocketDebuggerUrl: string };
        wsEndpoint = data.webSocketDebuggerUrl;
      }
      this.browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
      const pages = await this.browser.pages();
      this.page = pages[0] ?? (await this.browser.newPage());
      return { browser: this.browser, page: this.page };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot connect to Chrome via CDP (${msg}). ` +
        'Start Chrome with --remote-debugging-port=9222, or use httpFetch/shell tools instead.',
      );
    }
  }

  async navigate(url: string, _options?: BrowserCommandOptions): Promise<string> {
    const { page } = await this.ensureConnected();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    return `Navigated to ${page.url()} - Title: ${await page.title()}`;
  }

  async getPageText(_options?: BrowserCommandOptions): Promise<string> {
    const { page } = await this.ensureConnected();
    const text = await page.evaluate(() => document.body.innerText);
    const maxLen = 10000;
    return text.length > maxLen ? text.slice(0, maxLen) + '\n... (truncated)' : text;
  }

  async screenshot(path?: string, _options?: BrowserCommandOptions): Promise<string> {
    const { page } = await this.ensureConnected();
    const filePath = path ?? `/tmp/cereworker-screenshot-${Date.now()}.png`;
    await page.screenshot({ path: filePath, fullPage: false });
    return `Screenshot saved to ${filePath}`;
  }

  async click(selector: string, _options?: BrowserCommandOptions): Promise<string> {
    const { page } = await this.ensureConnected();
    try {
      await page.click(selector);
      return `Clicked: ${selector}`;
    } catch {
      return `Element not found: ${selector}`;
    }
  }

  async clickByText(text: string, role?: string, _options?: BrowserCommandOptions): Promise<string> {
    const { page } = await this.ensureConnected();
    try {
      const selector = role ? `[role="${role}"]` : 'button, [role="button"], a';
      const clicked = await page.evaluate((sel: string, txt: string) => {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          if (el.textContent?.trim() === txt) { (el as HTMLElement).click(); return true; }
        }
        return false;
      }, selector, text);
      return clicked ? `Clicked element with text: "${text}"` : `No clickable element found with text: "${text}"`;
    } catch {
      return `No clickable element found with text: "${text}"`;
    }
  }

  async type(selector: string, text: string, _options?: BrowserCommandOptions): Promise<string> {
    const { page } = await this.ensureConnected();
    try {
      await page.type(selector, text);
      return `Typed into: ${selector}`;
    } catch {
      return `Element not found: ${selector}`;
    }
  }

  async evaluate(code: string, _options?: BrowserCommandOptions): Promise<string> {
    const { page } = await this.ensureConnected();
    try {
      const result = await page.evaluate(code);
      return String(result ?? '(no result)');
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async waitForSelector(selector: string, timeoutMs = 5000, _options?: BrowserCommandOptions): Promise<string> {
    const { page } = await this.ensureConnected();
    try {
      await page.waitForSelector(selector, { timeout: timeoutMs });
      return `Found: ${selector}`;
    } catch {
      return `Timeout waiting for: ${selector}`;
    }
  }

  async getPageUrl(_options?: BrowserCommandOptions): Promise<string> {
    const { page } = await this.ensureConnected();
    return page.url();
  }

  async listTabs(_options?: BrowserCommandOptions): Promise<TabInfo[]> {
    const { browser, page } = await this.ensureConnected();
    const pages = await browser.pages();
    return pages.map((p, i) => ({
      id: String(i),
      title: '',
      url: p.url(),
      active: p === page,
    }));
  }

  async switchTab(tabId: string, _options?: BrowserCommandOptions): Promise<string> {
    const { browser } = await this.ensureConnected();
    const pages = await browser.pages();
    const idx = parseInt(tabId, 10);
    if (isNaN(idx) || idx < 0 || idx >= pages.length) {
      return `Invalid tab id: ${tabId}. Use browserListTabs to see available tabs.`;
    }
    this.page = pages[idx];
    await this.page.bringToFront();
    return `Switched to tab ${idx}: ${this.page.url()}`;
  }

  async newTab(url?: string, _options?: BrowserCommandOptions): Promise<string> {
    const { browser } = await this.ensureConnected();
    const page = await browser.newPage();
    if (url) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    }
    this.page = page;
    const pages = await browser.pages();
    return `Opened new tab (${pages.length} total)${url ? `: ${page.url()}` : ''}`;
  }

  async closeTab(tabId?: string, _options?: BrowserCommandOptions): Promise<string> {
    const { browser } = await this.ensureConnected();
    const pages = await browser.pages();
    if (pages.length <= 1) return 'Cannot close the last tab.';

    if (tabId !== undefined) {
      const idx = parseInt(tabId, 10);
      if (isNaN(idx) || idx < 0 || idx >= pages.length) return `Invalid tab id: ${tabId}`;
      const wasActive = pages[idx] === this.page;
      await pages[idx].close();
      if (wasActive) {
        const remaining = await browser.pages();
        this.page = remaining[remaining.length - 1];
      }
      return `Closed tab ${idx}`;
    }

    await this.page!.close();
    const remaining = await browser.pages();
    this.page = remaining[remaining.length - 1];
    return `Closed current tab. Now on: ${this.page.url()}`;
  }

  async connect(_options?: BrowserCommandOptions): Promise<string> {
    const { page } = await this.ensureConnected();
    return `Connected to Chrome via CDP. Current page: ${page.url()}`;
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      this.browser.disconnect();
      this.browser = null;
      this.page = null;
    }
  }

  isConnected(): boolean {
    return this.browser !== null && this.browser.connected;
  }
}
