import type { BrowserBackend, BrowserCommandOptions, TabInfo } from './backend.js';
import type { BrowserRelay } from './relay.js';

export class ExtensionBackend implements BrowserBackend {
  private relay: BrowserRelay;

  constructor(relay: BrowserRelay) {
    this.relay = relay;
  }

  async navigate(url: string, options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('navigate', { url }, 30_000, options?.abortSignal);
  }

  async getPageText(options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('getPageText', undefined, 30_000, options?.abortSignal);
  }

  async screenshot(path?: string, options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('screenshot', { path }, 30_000, options?.abortSignal);
  }

  async click(selector: string, options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('click', { selector }, 30_000, options?.abortSignal);
  }

  async clickByText(text: string, role?: string, options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('clickByText', { text, role }, 30_000, options?.abortSignal);
  }

  async type(selector: string, text: string, options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('type', { selector, text }, 30_000, options?.abortSignal);
  }

  async evaluate(code: string, options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('evaluate', { code }, 30_000, options?.abortSignal);
  }

  async waitForSelector(selector: string, timeoutMs = 5000, options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('waitForSelector', { selector, timeout: timeoutMs }, timeoutMs + 5000, options?.abortSignal);
  }

  async getPageUrl(options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('getPageUrl', undefined, 30_000, options?.abortSignal);
  }

  async listTabs(options?: BrowserCommandOptions): Promise<TabInfo[]> {
    const result = await this.relay.send('listTabs', undefined, 30_000, options?.abortSignal);
    return JSON.parse(result) as TabInfo[];
  }

  async switchTab(tabId: string, options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('switchTab', { tabId }, 30_000, options?.abortSignal);
  }

  async newTab(url?: string, options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('newTab', { url }, 30_000, options?.abortSignal);
  }

  async closeTab(tabId?: string, options?: BrowserCommandOptions): Promise<string> {
    return this.relay.send('closeTab', { tabId }, 30_000, options?.abortSignal);
  }

  async connect(_options?: BrowserCommandOptions): Promise<string> {
    if (!this.relay.isExtensionConnected()) {
      throw new Error(
        'Chrome extension not connected. Load the CereWorker extension in Chrome, ' +
        'configure the relay port and token in extension options, then click the extension icon.',
      );
    }
    return 'Connected to Chrome via extension';
  }

  async disconnect(): Promise<void> {
    // Extension stays connected — nothing to tear down from backend side
  }

  isConnected(): boolean {
    return this.relay.isExtensionConnected();
  }
}
