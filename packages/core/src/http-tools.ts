import type { ToolDefinition } from './orchestrator.js';

export interface HttpToolConfig {
  timeout: number;
  maxResponseSize: number;
  allowPrivate: boolean;
}

const DEFAULT_HTTP_CONFIG: HttpToolConfig = {
  timeout: 30000,
  maxResponseSize: 102400,
  allowPrivate: false,
};

const PRIVATE_PATTERNS = [
  /^file:\/\//i,
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/\[::1\]/,
];

function isPrivateUrl(url: string): boolean {
  return PRIVATE_PATTERNS.some((p) => p.test(url));
}

export function createHttpTools(
  config: Partial<HttpToolConfig> = {},
): Record<string, ToolDefinition> {
  const cfg = { ...DEFAULT_HTTP_CONFIG, ...config };

  return {
    httpFetch: {
      description: 'Make an HTTP request. Returns status code and response body.',
      parameters: {
        url: { type: 'string', description: 'The URL to fetch' },
        method: { type: 'string', description: 'HTTP method: GET, POST, PUT, DELETE, PATCH, HEAD (default: GET)' },
        headers: { type: 'object', description: 'Request headers as key-value pairs' },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
        timeout: { type: 'number', description: 'Request timeout in milliseconds (default: 30000)' },
      },
      execute: async (args) => {
        const { url, method: m, headers, body, timeout: t } = args as {
          url: string;
          method?: string;
          headers?: Record<string, string>;
          body?: string;
          timeout?: number;
        };
        const method = m ?? 'GET';
        const timeout = t ?? cfg.timeout;

        if (!cfg.allowPrivate && isPrivateUrl(url)) {
          return 'Blocked: requests to private/local URLs are disabled. Set tools.http.allowPrivate to enable.';
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await fetch(url, {
            method,
            headers,
            body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
            signal: controller.signal,
          });

          const contentType = response.headers.get('content-type') ?? 'unknown';
          let responseBody = await response.text();
          if (responseBody.length > cfg.maxResponseSize) {
            responseBody =
              responseBody.slice(0, cfg.maxResponseSize) + '\n... (response truncated)';
          }

          return `HTTP ${response.status} ${response.statusText}\nContent-Type: ${contentType}\n\n${responseBody}`;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            return `Request timed out after ${timeout}ms`;
          }
          return `HTTP error: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          clearTimeout(timer);
        }
      },
    },

    webSearch: {
      description:
        'Search the web using DuckDuckGo. Returns titles, URLs, and snippets. No API key required.',
      parameters: {
        query: { type: 'string', description: 'The search query' },
        maxResults: { type: 'number', description: 'Maximum number of results (default: 5)' },
      },
      execute: async (args) => {
        const { query, maxResults: mr } = args as { query: string; maxResults?: number };
        const maxResults = mr ?? 5;
        const encoded = encodeURIComponent(query);

        try {
          // Try DuckDuckGo HTML search
          const response = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
            headers: {
              'User-Agent': 'CereWorker/1.0',
            },
          });
          const html = await response.text();

          const results = parseDdgHtml(html, maxResults);
          if (results.length > 0) {
            return results
              .map(
                (r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`,
              )
              .join('\n\n');
          }

          // Fallback: DuckDuckGo Instant Answer API
          const apiResp = await fetch(
            `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1`,
          );
          const data = (await apiResp.json()) as DdgApiResponse;

          if (data.AbstractText) {
            return `${data.AbstractText}\nSource: ${data.AbstractURL}`;
          }
          if (data.RelatedTopics && data.RelatedTopics.length > 0) {
            return data.RelatedTopics.slice(0, maxResults)
              .map((t, i) => `${i + 1}. ${t.Text}\n   URL: ${t.FirstURL}`)
              .join('\n\n');
          }

          return 'No search results found.';
        } catch (err) {
          return `Search error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface DdgApiResponse {
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: Array<{ Text: string; FirstURL: string }>;
}

function parseDdgHtml(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results use class="result__a" for links and class="result__snippet" for descriptions
  const linkRegex = /class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)</g;
  const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\//g;

  const links: Array<{ url: string; title: string }> = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null && links.length < max) {
    let url = match[1];
    // DDG wraps URLs in a redirect; extract the actual URL
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    links.push({ url, title: match[2].trim() });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null && snippets.length < max) {
    snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}
