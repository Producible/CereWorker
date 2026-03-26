// CereWorker Browser Bridge — Service Worker
// Connects to the CereWorker relay server via WebSocket and executes commands
// using Chrome extension APIs (tabs, scripting).

let ws = null;
let connected = false;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

// Default config
let config = { port: 18900, token: '' };

// Load config from storage
chrome.storage.local.get(['relayPort', 'relayToken'], (result) => {
  if (result.relayPort) config.port = result.relayPort;
  if (result.relayToken) config.token = result.relayToken;
});

// Listen for config changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.relayPort) config.port = changes.relayPort.newValue;
  if (changes.relayToken) config.token = changes.relayToken.newValue;
  // Reconnect with new config
  if (ws) {
    ws.close();
  }
});

// Keep service worker alive with alarms
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive' && connected) {
    // Ping is handled by WebSocket protocol; alarm just keeps SW alive
  }
});

// Toggle connection on icon click
chrome.action.onClicked.addListener(() => {
  if (connected) {
    disconnect();
  } else {
    connectToRelay();
  }
});

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function disconnect() {
  if (ws) {
    ws.close();
    ws = null;
  }
  connected = false;
  setBadge('', '#888');
}

function connectToRelay() {
  if (ws && ws.readyState <= 1) return; // Already open or connecting

  const tokenParam = config.token ? `?token=${encodeURIComponent(config.token)}` : '';
  const url = `ws://127.0.0.1:${config.port}/extension${tokenParam}`;

  setBadge('...', '#F59E0B');

  try {
    ws = new WebSocket(url);
  } catch (err) {
    setBadge('!', '#EF4444');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    reconnectDelay = 1000;
    setBadge('ON', '#22C55E');
    // Send hello
    ws.send(JSON.stringify({ type: 'hello', version: '1.0.0' }));
  };

  ws.onclose = () => {
    connected = false;
    setBadge('', '#888');
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    setBadge('!', '#EF4444');
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type !== 'command' || !msg.id || !msg.method) return;

    try {
      const result = await handleCommand(msg.method, msg.params || {});
      sendResult(msg.id, result);
    } catch (err) {
      sendResult(msg.id, null, err.message || String(err));
    }
  };
}

function sendResult(id, result, error) {
  if (!ws || ws.readyState !== 1) return;
  const msg = { type: 'result', id };
  if (error) {
    msg.error = error;
  } else {
    msg.result = result;
  }
  ws.send(JSON.stringify(msg));
}

function scheduleReconnect() {
  setTimeout(() => {
    if (!connected) connectToRelay();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// --- Command handlers ---

async function handleCommand(method, params) {
  switch (method) {
    case 'navigate': return cmdNavigate(params);
    case 'getPageText': return cmdGetPageText();
    case 'screenshot': return cmdScreenshot();
    case 'click': return cmdClick(params);
    case 'type': return cmdType(params);
    case 'evaluate': return cmdEvaluate(params);
    case 'clickByText': return cmdClickByText(params);
    case 'waitForSelector': return cmdWaitForSelector(params);
    case 'getPageUrl': return cmdGetPageUrl();
    case 'listTabs': return cmdListTabs();
    case 'switchTab': return cmdSwitchTab(params);
    case 'newTab': return cmdNewTab(params);
    case 'closeTab': return cmdCloseTab(params);
    default: throw new Error(`Unknown method: ${method}`);
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab;
}

async function cmdNavigate({ url }) {
  if (!url) throw new Error('url is required');
  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id, { url });
  // Wait for load
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout after 30s
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
  const updated = await chrome.tabs.get(tab.id);
  return `Navigated to ${updated.url} - Title: ${updated.title || ''}`;
}

async function cmdGetPageText() {
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const text = document.body.innerText;
      return text.length > 10000 ? text.slice(0, 10000) + '\n... (truncated)' : text;
    },
  });
  return result?.result ?? '';
}

async function cmdScreenshot() {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  return dataUrl; // Base64 data URL
}

async function cmdClick({ selector }) {
  if (!selector) throw new Error('selector is required');
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return `Element not found: ${sel}`;
      // Use full mouse event sequence for React/SPA compatibility
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      el.dispatchEvent(new MouseEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      return `Clicked: ${sel}`;
    },
    args: [selector],
  });
  return result?.result ?? `Element not found: ${selector}`;
}

async function cmdClickByText({ text, role }) {
  if (!text) throw new Error('text is required');
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (txt, roleFilter) => {
      // Find clickable elements containing the target text
      const candidates = roleFilter
        ? document.querySelectorAll(`[role="${roleFilter}"]`)
        : document.querySelectorAll('button, [role="button"], a, [tabindex]');
      for (const el of candidates) {
        if (el.textContent.trim() === txt || el.innerText.trim() === txt) {
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
          el.dispatchEvent(new MouseEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new MouseEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
          return `Clicked element with text: "${txt}"`;
        }
      }
      return `No clickable element found with text: "${txt}"`;
    },
    args: [text, role || null],
  });
  return result?.result ?? `No clickable element found with text: "${text}"`;
}

async function cmdType({ selector, text }) {
  if (!selector || text === undefined) throw new Error('selector and text are required');
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, txt) => {
      const el = document.querySelector(sel);
      if (!el) return `Element not found: ${sel}`;
      el.focus();

      // contentEditable elements (React editors like X's tweet box)
      if (el.isContentEditable || el.getAttribute('contenteditable') !== null) {
        // Clear existing content and insert via execCommand for React compatibility
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, txt);
        return `Typed into: ${sel}`;
      }

      // Standard input/textarea elements
      const nativeSet = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (nativeSet) {
        nativeSet.call(el, txt);
      } else {
        el.value = txt;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `Typed into: ${sel}`;
    },
    args: [selector, text],
  });
  return result?.result ?? `Element not found: ${selector}`;
}

async function cmdEvaluate({ code }) {
  if (!code) throw new Error('code is required');
  const tab = await getActiveTab();
  // Use MAIN world to bypass extension CSP — runs as if typed in devtools console
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (c) => {
      try {
        const r = new Function(c)();
        return String(r ?? '(no result)');
      } catch (err) {
        return `Error: ${err.message || String(err)}`;
      }
    },
    args: [code],
  });
  return result?.result ?? '(no result)';
}

async function cmdWaitForSelector({ selector, timeout = 5000 }) {
  if (!selector) throw new Error('selector is required');
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, ms) => {
      return new Promise((resolve) => {
        if (document.querySelector(sel)) {
          resolve(`Found: ${sel}`);
          return;
        }
        const observer = new MutationObserver(() => {
          if (document.querySelector(sel)) {
            observer.disconnect();
            resolve(`Found: ${sel}`);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(`Timeout waiting for: ${sel}`);
        }, ms);
      });
    },
    args: [selector, timeout],
  });
  return result?.result ?? `Timeout waiting for: ${selector}`;
}

async function cmdGetPageUrl() {
  const tab = await getActiveTab();
  return tab.url || '';
}

async function cmdListTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const result = tabs.map((t) => ({
    id: String(t.id),
    title: t.title || '',
    url: t.url || '',
    active: t.active,
  }));
  return JSON.stringify(result);
}

async function cmdSwitchTab({ tabId }) {
  if (!tabId) throw new Error('tabId is required');
  const id = parseInt(tabId, 10);
  await chrome.tabs.update(id, { active: true });
  const tab = await chrome.tabs.get(id);
  return `Switched to tab ${id}: ${tab.url}`;
}

async function cmdNewTab({ url }) {
  const tab = await chrome.tabs.create({ url: url || undefined });
  if (url) {
    // Wait for load
    await new Promise((resolve) => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 30000);
    });
  }
  const updated = await chrome.tabs.get(tab.id);
  return `Opened new tab: ${updated.url || 'about:blank'}`;
}

async function cmdCloseTab({ tabId }) {
  if (tabId) {
    const id = parseInt(tabId, 10);
    await chrome.tabs.remove(id);
    return `Closed tab ${id}`;
  }
  const tab = await getActiveTab();
  await chrome.tabs.remove(tab.id);
  return 'Closed current tab';
}

// Auto-connect on startup
connectToRelay();
