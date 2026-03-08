import puppeteer, { type Browser, type Page } from 'puppeteer';

export interface BrowserSession {
  browser: Browser;
  page: Page;
}

let session: BrowserSession | null = null;

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
  if (session) {
    await session.browser.close();
    session = null;
  }
}

export function getSession(): BrowserSession | null {
  return session;
}

export async function navigateTo(url: string): Promise<string> {
  const s = await launchBrowser();
  await s.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  return `Navigated to ${s.page.url()} - Title: ${await s.page.title()}`;
}

export async function getPageText(): Promise<string> {
  const s = await launchBrowser();
  const text = await s.page.evaluate(() => document.body.innerText);
  // Truncate to avoid massive output
  const maxLen = 10000;
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + '\n... (truncated)';
  }
  return text;
}

export async function screenshot(path?: string): Promise<string> {
  const s = await launchBrowser();
  const filePath = path ?? `/tmp/cereworker-screenshot-${Date.now()}.png`;
  await s.page.screenshot({ path: filePath, fullPage: false });
  return `Screenshot saved to ${filePath}`;
}

export async function clickElement(selector: string): Promise<string> {
  const s = await launchBrowser();
  try {
    await s.page.click(selector);
    return `Clicked: ${selector}`;
  } catch {
    return `Element not found: ${selector}`;
  }
}

export async function typeText(selector: string, text: string): Promise<string> {
  const s = await launchBrowser();
  try {
    await s.page.type(selector, text);
    return `Typed into: ${selector}`;
  } catch {
    return `Element not found: ${selector}`;
  }
}

export async function evaluateJs(code: string): Promise<string> {
  const s = await launchBrowser();
  try {
    const result = await s.page.evaluate(code);
    return String(result ?? '(no result)');
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function waitForSelector(selector: string, timeoutMs = 5000): Promise<string> {
  const s = await launchBrowser();
  try {
    await s.page.waitForSelector(selector, { timeout: timeoutMs });
    return `Found: ${selector}`;
  } catch {
    return `Timeout waiting for: ${selector}`;
  }
}

export async function getPageUrl(): Promise<string> {
  const s = await launchBrowser();
  return s.page.url();
}
