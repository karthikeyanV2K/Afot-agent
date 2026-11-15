/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AFOT High-Power Web Search Engine.
 *
 * Connects to external AI search engines via API providers:
 *   1. Exa (neural search, highlights, auto-prompting)
 *   2. Firecrawl (web search with instant markdown extraction)
 *   3. Parallel (natural-language objective search)
 *   4. Tavily (agentic search with direct AI answers + content)
 *   5. TinyFish (structured web search)
 *   6. Brave Search (independent index)
 *   7. Serper (Google Search API)
 *   8. DuckDuckGo Organic (zero-key free fallback that searches real web results)
 *
 * Provider selection follows ~/.afot/config.json websearch.provider or $env:AFOT_WEBSEARCH_PROVIDER:
 *   'auto'   — auto-detects configured API keys and selects the best provider,
 *              falling back gracefully to DuckDuckGo Organic.
 *   'random' — rotates randomly among configured providers.
 *   or specific: 'exa' | 'firecrawl' | 'parallel' | 'tavily' | 'tinyfish' | 'brave' | 'serper' | 'duckduckgo'
 */

import { debugLogger } from '../utils/debugLogger.js';
import { getAfotWebSearchConfig } from './afotAuthStorage.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  provider: string;
  query: string;
  answer?: string;
}

const SEARCH_TIMEOUT_MS = 12000;

function createTimeoutSignal(timeoutMs: number = SEARCH_TIMEOUT_MS): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

// ─── 1. Exa Search (Neural & Embedding Search) ───────────────────────────────

async function searchExa(
  query: string,
  apiKey: string,
): Promise<{ results: SearchResult[]; answer?: string }> {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: 8,
      useAutoprompt: true,
      contents: {
        text: { maxCharacters: 1200 },
        highlights: { numSentences: 2 },
      },
    }),
    signal: createTimeoutSignal(),
  });

  if (!res.ok) throw new Error(`Exa HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    results?: Array<{
      title?: string;
      url: string;
      text?: string;
      highlights?: string[];
    }>;
  };

  const results: SearchResult[] = (data.results ?? []).map((r) => {
    const highlights = r.highlights?.join(' ')?.trim();
    const snippet = highlights || r.text?.slice(0, 400)?.trim() || '';
    return {
      title: r.title || r.url,
      url: r.url,
      snippet,
      content: r.text,
    };
  });

  return { results };
}

// ─── 2. Firecrawl Search ──────────────────────────────────────────────────────

async function searchFirecrawl(
  query: string,
  apiKey: string,
): Promise<{ results: SearchResult[]; answer?: string }> {
  const res = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      limit: 8,
      scrapeOptions: {
        formats: ['markdown'],
      },
    }),
    signal: createTimeoutSignal(),
  });

  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    success?: boolean;
    data?: Array<{
      title?: string;
      url: string;
      markdown?: string;
      description?: string;
      metadata?: { title?: string; description?: string };
    }>;
  };

  const items = Array.isArray(data.data) ? data.data : [];
  const results: SearchResult[] = items.map((r) => ({
    title: r.title || r.metadata?.title || r.url,
    url: r.url,
    snippet: r.description || r.metadata?.description || r.markdown?.slice(0, 400)?.trim() || '',
    content: r.markdown,
  }));

  return { results };
}

// ─── 3. Parallel Search ───────────────────────────────────────────────────────

async function searchParallel(
  query: string,
  apiKey: string,
): Promise<{ results: SearchResult[]; answer?: string }> {
  const res = await fetch('https://api.parallel.ai/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: 8,
    }),
    signal: createTimeoutSignal(),
  });

  if (!res.ok) throw new Error(`Parallel HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    results?: Array<{
      title?: string;
      url: string;
      snippet?: string;
      excerpt?: string;
    }>;
  };

  const results: SearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.excerpt || r.snippet || '',
  }));

  return { results };
}

// ─── 4. Tavily Search (with Direct AI Answer) ────────────────────────────────

async function searchTavily(
  query: string,
  apiKey: string,
): Promise<{ results: SearchResult[]; answer?: string }> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'advanced',
      include_answer: true,
      max_results: 8,
    }),
    signal: createTimeoutSignal(),
  });

  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    answer?: string;
    results?: Array<{ title: string; url: string; content: string }>;
  };

  const results: SearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));

  return { results, answer: data.answer };
}

// ─── 5. TinyFish Search ───────────────────────────────────────────────────────

async function searchTinyFish(
  query: string,
  apiKey: string,
): Promise<{ results: SearchResult[]; answer?: string }> {
  const res = await fetch('https://api.tinyfish.ai/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      limit: 8,
    }),
    signal: createTimeoutSignal(),
  });

  if (!res.ok) throw new Error(`TinyFish HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url: string; snippet?: string; description?: string }>;
  };

  const results: SearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.snippet || r.description || '',
  }));

  return { results };
}

// ─── 6. Brave Search ──────────────────────────────────────────────────────────

async function searchBrave(
  query: string,
  apiKey: string,
): Promise<{ results: SearchResult[]; answer?: string }> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
    signal: createTimeoutSignal(),
  });

  if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };

  const results: SearchResult[] = (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));

  return { results };
}

// ─── 7. Serper (Google Search API) ───────────────────────────────────────────

async function searchSerper(
  query: string,
  apiKey: string,
): Promise<{ results: SearchResult[]; answer?: string }> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({ q: query, num: 8 }),
    signal: createTimeoutSignal(),
  });

  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = (await res.json()) as {
    organic?: Array<{ title: string; link: string; snippet: string }>;
  };

  const results: SearchResult[] = (data.organic ?? []).map((r) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
  }));

  return { results };
}

// ─── 8. DuckDuckGo Organic HTML Search (Zero-Key Free Fallback) ───────────────

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function searchDuckDuckGoOrganic(
  query: string,
): Promise<{ results: SearchResult[]; answer?: string }> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
    },
    body: 'q=' + encodeURIComponent(query),
    signal: createTimeoutSignal(10000),
  });

  if (!res.ok) throw new Error(`DuckDuckGo HTML HTTP ${res.status}`);
  const html = await res.text();

  const titleRegex =
    /<h2 class="result__title">[\s\S]*?<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles = [...html.matchAll(titleRegex)];
  const snippets = [...html.matchAll(snipRegex)];

  const results: SearchResult[] = [];
  const limit = Math.min(8, titles.length);

  for (let i = 0; i < limit; i++) {
    let url = titles[i][1];
    const rawTitle = titles[i][2].replace(/<[^>]+>/g, '').trim();
    const rawSnippet = snippets[i]
      ? snippets[i][1].replace(/<[^>]+>/g, '').trim()
      : '';

    // Handle DDG redirect wrappers: //duckduckgo.com/l/?uddg=https%3A%2F%2F...
    if (url.includes('uddg=')) {
      const match = url.match(/uddg=([^&]+)/);
      if (match) {
        try {
          url = decodeURIComponent(match[1]);
        } catch {
          // ignore decode error
        }
      }
    } else if (url.startsWith('//')) {
      url = 'https:' + url;
    }

    results.push({
      title: decodeHtmlEntities(rawTitle),
      url,
      snippet: decodeHtmlEntities(rawSnippet),
    });
  }

  return { results };
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

interface SearchProviderDef {
  name: string;
  key: string;
  fn: (q: string, k: string) => Promise<{ results: SearchResult[]; answer?: string }>;
  requiresKey: boolean;
}

/**
 * Performs high-power web search across AI search providers,
 * falling back gracefully through available providers until results are returned.
 */
export async function afotWebSearch(query: string): Promise<SearchResponse> {
  const ws = getAfotWebSearchConfig();
  const strategy = ws.provider || 'auto';

  const allProviders: SearchProviderDef[] = [
    {
      name: 'tavily',
      key: ws.tavilyApiKey || '',
      fn: searchTavily,
      requiresKey: true,
    },
    {
      name: 'exa',
      key: ws.exaApiKey || '',
      fn: searchExa,
      requiresKey: true,
    },
    {
      name: 'firecrawl',
      key: ws.firecrawlApiKey || '',
      fn: searchFirecrawl,
      requiresKey: true,
    },
    {
      name: 'parallel',
      key: ws.parallelApiKey || '',
      fn: searchParallel,
      requiresKey: true,
    },
    {
      name: 'tinyfish',
      key: ws.tinyfishApiKey || '',
      fn: searchTinyFish,
      requiresKey: true,
    },
    {
      name: 'brave',
      key: ws.braveApiKey || '',
      fn: searchBrave,
      requiresKey: true,
    },
    {
      name: 'serper',
      key: ws.serperApiKey || '',
      fn: searchSerper,
      requiresKey: true,
    },
    {
      name: 'duckduckgo',
      key: '',
      fn: async (q) => searchDuckDuckGoOrganic(q),
      requiresKey: false,
    },
  ];

  if (strategy === 'none') {
    return { results: [], provider: 'none', query };
  }

  let candidates: SearchProviderDef[];

  if (strategy === 'random') {
    const configured = allProviders.filter((p) => !p.requiresKey || p.key);
    const pool = configured.length > 0 ? configured : allProviders;
    const shuffled = [...pool].sort(() => 0.5 - Math.random());
    candidates = shuffled;
  } else if (strategy !== 'auto') {
    const specific = allProviders.find((p) => p.name === strategy);
    candidates = specific ? [specific, ...allProviders.filter((p) => p !== specific)] : allProviders;
  } else {
    // auto: Prioritize configured AI search engines first, then DuckDuckGo
    const configured = allProviders.filter((p) => p.requiresKey && Boolean(p.key));
    const zeroKey = allProviders.filter((p) => !p.requiresKey);
    candidates = [...configured, ...zeroKey];
  }

  for (const provider of candidates) {
    try {
      debugLogger.log(`AFOT WebSearch: Trying provider "${provider.name}" for "${query}"...`);
      const { results, answer } = await provider.fn(query, provider.key);
      if (results && results.length > 0) {
        debugLogger.log(
          `AFOT WebSearch: Provider "${provider.name}" returned ${results.length} results.`,
        );
        return {
          results,
          provider: provider.name,
          query,
          ...(answer ? { answer } : {}),
        };
      }
    } catch (err) {
      debugLogger.warn(`AFOT WebSearch: Provider "${provider.name}" failed: ${err}`);
    }
  }

  return { results: [], provider: 'none', query };
}

/**
 * Formats search results into an optimized markdown string for LLM ingestion.
 */
export function formatSearchResults(response: SearchResponse): string {
  if (response.results.length === 0) {
    return `No search results found for: "${response.query}"`;
  }

  const lines: string[] = [
    `Search results for: "${response.query}" (via ${response.provider})`,
    '',
  ];

  if (response.answer) {
    lines.push(`### 🤖 Direct Answer Summary:`);
    lines.push(response.answer);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  for (let i = 0; i < response.results.length; i++) {
    const r = response.results[i];
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    URL: ${r.url}`);
    if (r.snippet) {
      lines.push(`    Summary: ${r.snippet}`);
    }
    if (r.content && r.content.length > 0 && r.content !== r.snippet) {
      const excerpt = r.content.slice(0, 600).trim();
      lines.push(`    Excerpt: ${excerpt}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
