export interface TabInfo {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserBackend {
  // Page operations
  navigate(url: string): Promise<string>;
  getPageText(): Promise<string>;
  screenshot(path?: string): Promise<string>;
  click(selector: string): Promise<string>;
  clickByText(text: string, role?: string): Promise<string>;
  type(selector: string, text: string): Promise<string>;
  evaluate(code: string): Promise<string>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<string>;
  getPageUrl(): Promise<string>;

  // Tab operations
  listTabs(): Promise<TabInfo[]>;
  switchTab(tabId: string): Promise<string>;
  newTab(url?: string): Promise<string>;
  closeTab(tabId?: string): Promise<string>;

  // Lifecycle
  connect(): Promise<string>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}
