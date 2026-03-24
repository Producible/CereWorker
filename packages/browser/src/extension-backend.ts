import type { BrowserBackend, TabInfo } from './backend.js';
import type { BrowserRelay } from './relay.js';

export class ExtensionBackend implements BrowserBackend {
  private relay: BrowserRelay;

  constructor(relay: BrowserRelay) {
    this.relay = relay;
  }

  async navigate(url: string): Promise<string> {
    return this.relay.send('navigate', { url });
  }

  async getPageText(): Promise<string> {
    return this.relay.send('getPageText');
  }

  async screenshot(path?: string): Promise<string> {
    return this.relay.send('screenshot', { path });
  }

  async click(selector: string): Promise<string> {
    return this.relay.send('click', { selector });
  }

  async type(selector: string, text: string): Promise<string> {
    return this.relay.send('type', { selector, text });
  }

  async evaluate(code: string): Promise<string> {
    return this.relay.send('evaluate', { code });
  }

  async waitForSelector(selector: string, timeoutMs = 5000): Promise<string> {
    return this.relay.send('waitForSelector', { selector, timeout: timeoutMs }, timeoutMs + 5000);
  }

  async getPageUrl(): Promise<string> {
    return this.relay.send('getPageUrl');
  }

  async listTabs(): Promise<TabInfo[]> {
    const result = await this.relay.send('listTabs');
    return JSON.parse(result) as TabInfo[];
  }

  async switchTab(tabId: string): Promise<string> {
    return this.relay.send('switchTab', { tabId });
  }

  async newTab(url?: string): Promise<string> {
    return this.relay.send('newTab', { url });
  }

  async closeTab(tabId?: string): Promise<string> {
    return this.relay.send('closeTab', { tabId });
  }

  async connect(): Promise<string> {
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
