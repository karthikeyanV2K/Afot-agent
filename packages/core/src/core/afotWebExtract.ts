/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AFOT Web Extraction & Deep Reader Engine.
 *
 * Implements Step 2 of the Two-Step Discovery-and-Extraction architecture:
 * Takes any webpage URL and extracts clean, LLM-ready Markdown / structured text,
 * bypassing JavaScript barriers, anti-scraping, cookie popups, and navigation chrome.
 *
 * Supported Extraction Providers:
 *   1. Firecrawl (scrapes live JS sites into pristine Markdown)
 *   2. Tavily Extract (fast multi-URL structured extraction)
 *   3. Exa Contents (neural content & highlights extraction)
 *   4. TinyFish Fetch (headless browser crawl & extraction)
 *   5. Native Clean Reader (in-process HTML sanitizer & Markdown converter)
 */

import { convert } from 'html-to-text';
import { debugLogger } from '../utils/debugLogger.js';
import { getAfotWebSearchConfig } from './afotAuthStorage.js';

export interface ExtractedWebPage {
  url: string;
  title?: string;
  content: string;
  provider: string;
  contentType?: string;
}

const EXTRACT_TIMEOUT_MS = 15000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function createTimeoutSignal(
  timeoutMs: number = EXTRACT_TIMEOUT_MS,
  parentSignal?: AbortSignal,
): AbortSignal {
  if (parentSignal) return parentSignal;
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

// ─── 1. Firecrawl Scrape / Markdown Extraction ────────────────────────────────

async function extractFirecrawl(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ExtractedWebPage> {
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
    }),
    signal: createTimeoutSignal(EXTRACT_TIMEOUT_MS, signal),
  });

  if (!res.ok) throw new Error(`Firecrawl Scrape HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    success?: boolean;
    data?: {
      markdown?: string;
      metadata?: { title?: string; description?: string };
    };
  };

  const markdown = data.data?.markdown?.trim();
  if (!markdown) throw new Error('Firecrawl returned empty markdown content');

  return {
    url,
    title: data.data?.metadata?.title,
    content: markdown,
    provider: 'firecrawl',
    contentType: 'text/markdown',
  };
}

// ─── 2. Tavily Extract ────────────────────────────────────────────────────────

async function extractTavily(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ExtractedWebPage> {
  const res = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      urls: [url],
    }),
    signal: createTimeoutSignal(EXTRACT_TIMEOUT_MS, signal),
  });

  if (!res.ok) throw new Error(`Tavily Extract HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    results?: Array<{
      url: string;
      raw_content?: string;
    }>;
  };

  const result = data.results?.[0];
  const content = result?.raw_content?.trim();
  if (!content) throw new Error('Tavily extract returned empty content');

  return {
    url,
    content,
    provider: 'tavily',
    contentType: 'text/plain',
  };
}

// ─── 3. Exa Contents Extraction ───────────────────────────────────────────────

async function extractExa(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ExtractedWebPage> {
  const res = await fetch('https://api.exa.ai/contents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      urls: [url],
      text: true,
    }),
    signal: createTimeoutSignal(EXTRACT_TIMEOUT_MS, signal),
  });

  if (!res.ok) throw new Error(`Exa Contents HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    results?: Array<{
      url: string;
      title?: string;
      text?: string;
    }>;
  };

  const result = data.results?.[0];
  const content = result?.text?.trim();
  if (!content) throw new Error('Exa contents returned empty text');

  return {
    url,
    title: result?.title,
    content,
    provider: 'exa',
    contentType: 'text/plain',
  };
}

// ─── 4. TinyFish Fetch ────────────────────────────────────────────────────────

async function extractTinyFish(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ExtractedWebPage> {
  const res = await fetch('https://api.tinyfish.ai/v1/fetch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      render_js: true,
    }),
    signal: createTimeoutSignal(EXTRACT_TIMEOUT_MS, signal),
  });

  if (!res.ok) throw new Error(`TinyFish Fetch HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    text?: string;
    markdown?: string;
    title?: string;
  };

  const content = (data.markdown || data.text)?.trim();
  if (!content) throw new Error('TinyFish fetch returned empty content');

  return {
    url,
    title: data.title,
    content,
    provider: 'tinyfish',
    contentType: data.markdown ? 'text/markdown' : 'text/plain',
  };
}

// ─── 5. Native Clean Reader View (Zero-Key Local Fallback) ────────────────────

function cleanHtmlChrome(rawHtml: string): string {
  return rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, '');
}

export async function extractNativeClean(
  url: string,
  signal?: AbortSignal,
): Promise<ExtractedWebPage> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    },
    signal: createTimeoutSignal(EXTRACT_TIMEOUT_MS, signal),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const contentType = res.headers.get('content-type') || '';
  const rawText = await res.text();

  if (contentType.includes('text/html') || rawText.includes('<html') || rawText.includes('<!DOCTYPE')) {
    const cleanedHtml = cleanHtmlChrome(rawText);
    const textContent = convert(cleanedHtml, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: false, baseUrl: url } },
        { selector: 'img', format: 'skip' },
      ],
    }).trim();

    return {
      url,
      content: textContent,
      provider: 'native-reader',
      contentType: 'text/markdown',
    };
  }

  return {
    url,
    content: rawText.trim(),
    provider: 'native-fetch',
    contentType: contentType || 'text/plain',
  };
}

// ─── Extraction Dispatcher ────────────────────────────────────────────────────

/**
 * Deeply extracts webpage content using AI extraction providers (Firecrawl, Tavily, Exa, TinyFish).
 * Returns null if no external extraction provider is configured or if all fail, allowing native fetch.
 */
export async function afotWebExtract(
  url: string,
  signal?: AbortSignal,
): Promise<ExtractedWebPage | null> {
  const ws = getAfotWebSearchConfig();
  const extractStrategy = ws.extractProvider || 'auto';

  interface ExtractProviderDef {
    name: string;
    key: string;
    fn: (u: string, k: string, s?: AbortSignal) => Promise<ExtractedWebPage>;
    requiresKey: boolean;
  }

  const providers: ExtractProviderDef[] = [
    {
      name: 'firecrawl',
      key: ws.firecrawlApiKey || '',
      fn: extractFirecrawl,
      requiresKey: true,
    },
    {
      name: 'tavily',
      key: ws.tavilyApiKey || '',
      fn: extractTavily,
      requiresKey: true,
    },
    {
      name: 'exa',
      key: ws.exaApiKey || '',
      fn: extractExa,
      requiresKey: true,
    },
    {
      name: 'tinyfish',
      key: ws.tinyfishApiKey || '',
      fn: extractTinyFish,
      requiresKey: true,
    },
  ];

  let candidates: ExtractProviderDef[];

  if (extractStrategy === 'native') {
    return null;
  } else if (extractStrategy !== 'auto') {
    const matched = providers.find((p) => p.name === extractStrategy);
    candidates = matched && matched.key ? [matched] : [];
  } else {
    // auto: Try configured extraction providers in order
    candidates = providers.filter((p) => Boolean(p.key));
  }

  if (candidates.length === 0) {
    return null;
  }

  for (const provider of candidates) {
    try {
      debugLogger.log(`AFOT WebExtract: Trying provider "${provider.name}" on ${url}...`);
      const extracted = await provider.fn(url, provider.key, signal);
      if (extracted && extracted.content) {
        debugLogger.log(
          `AFOT WebExtract: Successfully extracted ${extracted.content.length} chars via "${provider.name}".`,
        );
        return extracted;
      }
    } catch (err) {
      debugLogger.warn(`AFOT WebExtract: Provider "${provider.name}" failed for ${url}: ${err}`);
    }
  }

  return null;
}
