export interface TabInfo {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserCommandOptions {
  abortSignal?: AbortSignal;
}

export interface BrowserBackend {
  // Page operations
  navigate(url: string, options?: BrowserCommandOptions): Promise<string>;
  getPageText(options?: BrowserCommandOptions): Promise<string>;
  screenshot(path?: string, options?: BrowserCommandOptions): Promise<string>;
  click(selector: string, options?: BrowserCommandOptions): Promise<string>;
  clickByText(text: string, role?: string, options?: BrowserCommandOptions): Promise<string>;
  type(selector: string, text: string, options?: BrowserCommandOptions): Promise<string>;
  evaluate(code: string, options?: BrowserCommandOptions): Promise<string>;
  waitForSelector(selector: string, timeoutMs?: number, options?: BrowserCommandOptions): Promise<string>;
  getPageUrl(options?: BrowserCommandOptions): Promise<string>;

  // Tab operations
  listTabs(options?: BrowserCommandOptions): Promise<TabInfo[]>;
  switchTab(tabId: string, options?: BrowserCommandOptions): Promise<string>;
  newTab(url?: string, options?: BrowserCommandOptions): Promise<string>;
  closeTab(tabId?: string, options?: BrowserCommandOptions): Promise<string>;

  // Lifecycle
  connect(options?: BrowserCommandOptions): Promise<string>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}
