/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AFOT Web Search — provider-agnostic search backend.
 *
 * When the Gemini grounding API is unavailable (AFOT_AUTH / non-Gemini providers),
 * this module provides fallback search via:
 *   1. Brave Search API  (braveApiKey in ~/.afot/config.json)
 *   2. Serper API        (serperApiKey)
 *   3. Tavily API        (tavilyApiKey)
 *   4. DuckDuckGo instant answer API (free, no key — limited)
 *
 * Provider selection follows config.json websearch.provider:
 *   'auto'   — tries providers in order until one returns results
 *   'random' — rotates randomly among configured providers
 *   or a specific name: 'brave' | 'serper' | 'tavily'
 */

import { debugLogger } from '../utils/debugLogger.js';
import { readAfotConfig } from './afotAuthStorage.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
  provider: string;
  query: string;
}

// ─── Brave Search ─────────────────────────────────────────────────────────────

async function searchBrave(
  query: string,
  apiKey: string,
): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });
  if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

// ─── Serper ───────────────────────────────────────────────────────────────────

async function searchSerper(
  query: string,
  apiKey: string,
): Promise<SearchResult[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({ q: query, num: 8 }),
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = (await res.json()) as {
    organic?: Array<{ title: string; link: string; snippet: string }>;
  };
  return (data.organic ?? []).map((r) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
  }));
}

// ─── Tavily ───────────────────────────────────────────────────────────────────

async function searchTavily(
  query: string,
  apiKey: string,
): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 8,
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title: string; url: string; content: string }>;
  };
  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

// ─── DuckDuckGo (free fallback) ───────────────────────────────────────────────

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AFOT-Agent/1.0' },
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const data = (await res.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    AbstractSource?: string;
    RelatedTopics?: Array<{
      Text?: string;
      FirstURL?: string;
    }>;
  };

  const results: SearchResult[] = [];
  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.AbstractSource ?? 'Summary',
      url: data.AbstractURL,
      snippet: data.AbstractText,
    });
  }
  for (const topic of data.RelatedTopics ?? []) {
    if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.slice(0, 80),
        url: topic.FirstURL,
        snippet: topic.Text,
      });
    }
    if (results.length >= 6) break;
  }
  return results;
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Performs a web search using the configured provider.
 * Falls back through providers automatically when strategy is 'auto'.
 */
export async function afotWebSearch(query: string): Promise<SearchResponse> {
  const config = readAfotConfig();
  const ws = config?.websearch ?? {};
  const strategy = ws.provider ?? 'auto';

  interface Provider {
    name: string;
    key: string | undefined;
    fn: (q: string, k: string) => Promise<SearchResult[]>;
    requiresKey: boolean;
  }

  const allProviders: Provider[] = [
    {
      name: 'brave',
      key: ws.braveApiKey?.trim(),
      fn: searchBrave,
      requiresKey: true,
    },
    {
      name: 'serper',
      key: ws.serperApiKey?.trim(),
      fn: searchSerper,
      requiresKey: true,
    },
    {
      name: 'tavily',
      key: ws.tavilyApiKey?.trim(),
      fn: searchTavily,
      requiresKey: true,
    },
    {
      name: 'duckduckgo',
      key: '',
      fn: async (q) => searchDuckDuckGo(q),
      requiresKey: false,
    },
  ];

  // Build candidate list based on strategy
  let candidates: Provider[];
  if (strategy === 'random') {
    const configured = allProviders.filter(
      (p) => !p.requiresKey || p.key,
    );
    if (configured.length === 0) candidates = allProviders;
    else {
      const idx = Math.floor(Math.random() * configured.length);
      candidates = [configured[idx], ...configured.filter((_, i) => i !== idx)];
    }
  } else if (strategy !== 'auto') {
    // Specific provider named
    const specific = allProviders.find((p) => p.name === strategy);
    candidates = specific ? [specific] : allProviders;
  } else {
    // auto — try in order, configured first
    candidates = [
      ...allProviders.filter((p) => !p.requiresKey || p.key),
      ...allProviders.filter((p) => p.requiresKey && !p.key),
    ];
  }

  for (const provider of candidates) {
    try {
      const results = await provider.fn(query, provider.key ?? '');
      if (results.length > 0) {
        return { results, provider: provider.name, query };
      }
    } catch (err) {
      debugLogger.warn(`AFOT WebSearch: ${provider.name} failed: ${err}`);
    }
  }

  return { results: [], provider: 'none', query };
}

/**
 * Formats search results into a markdown string for LLM consumption.
 */
export function formatSearchResults(response: SearchResponse): string {
  if (response.results.length === 0) {
    return `No results found for: "${response.query}"`;
  }

  const lines = [
    `Search results for: "${response.query}"  (via ${response.provider})`,
    '',
  ];
  for (let i = 0; i < response.results.length; i++) {
    const r = response.results[i];
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    ${r.url}`);
    lines.push(`    ${r.snippet}`);
    lines.push('');
  }
  return lines.join('\n');
}
