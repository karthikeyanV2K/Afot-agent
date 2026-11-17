/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { afotWebSearch, formatSearchResults } from './afotWebSearch.js';
import { afotWebExtract, extractNativeClean } from './afotWebExtract.js';

// DNS is not available (and must not be required) in unit tests.
const isPrivateIpMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/fetch.js')>()),
  isPrivateIp: isPrivateIpMock,
}));

describe('afotWebSearch & formatSearchResults', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    vi.stubEnv('PARALLEL_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('TINYFISH_API_KEY', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    vi.stubEnv('SERPER_API_KEY', '');
    vi.stubEnv('AFOT_WEBSEARCH_PROVIDER', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  it('should format search results cleanly including AI answer summary', () => {
    const formatted = formatSearchResults({
      provider: 'tavily',
      query: 'what is react 19 useActionState',
      answer: 'useActionState is a hook in React 19 for managing form actions.',
      results: [
        {
          title: 'React 19 Documentation',
          url: 'https://react.dev/reference/react/useActionState',
          snippet: 'useActionState accepts an action function and initial state.',
        },
      ],
    });

    expect(formatted).toContain('Direct Answer Summary');
    expect(formatted).toContain('useActionState is a hook');
    expect(formatted).toContain('[1] React 19 Documentation');
    expect(formatted).toContain('https://react.dev/reference/react/useActionState');
  });

  it('should use Exa search when EXA_API_KEY is configured', async () => {
    vi.stubEnv('EXA_API_KEY', 'exa-test-key');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: 'Exa Result 1',
            url: 'https://example.com/exa',
            highlights: ['Exa found this.'],
            text: 'Full text from Exa.',
          },
        ],
      }),
    });

    const res = await afotWebSearch('test query');
    expect(res.provider).toBe('exa');
    expect(res.results).toHaveLength(1);
    expect(res.results[0].title).toBe('Exa Result 1');
    expect(res.results[0].snippet).toBe('Exa found this.');
  });

  it('should use Firecrawl search when FIRECRAWL_API_KEY is configured', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test-key');
    vi.stubEnv('AFOT_WEBSEARCH_PROVIDER', 'firecrawl');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            title: 'Firecrawl Scraped Result',
            url: 'https://example.com/firecrawl',
            description: 'Fast markdown summary',
            markdown: '# Documentation\nDetails here...',
          },
        ],
      }),
    });

    const res = await afotWebSearch('firecrawl query');
    expect(res.provider).toBe('firecrawl');
    expect(res.results).toHaveLength(1);
    expect(res.results[0].title).toBe('Firecrawl Scraped Result');
    expect(res.results[0].content).toContain('# Documentation');
  });

  it('should use Tavily search with direct answer when TAVILY_API_KEY is configured', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'tv-test-key');
    vi.stubEnv('AFOT_WEBSEARCH_PROVIDER', 'tavily');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answer: 'Tavily synthesized answer.',
        results: [
          {
            title: 'Tavily Result',
            url: 'https://example.com/tavily',
            content: 'Detailed snippet from Tavily.',
          },
        ],
      }),
    });

    const res = await afotWebSearch('tavily query');
    expect(res.provider).toBe('tavily');
    expect(res.answer).toBe('Tavily synthesized answer.');
    expect(res.results[0].title).toBe('Tavily Result');
  });

  it('should fallback to DuckDuckGo organic search when no API keys are provided', async () => {
    const mockHtml = `
      <div class="serp__results">
        <h2 class="result__title">
          <a class="result__a" href="https://example.com/ddg">DuckDuckGo Organic Result</a>
        </h2>
        <a class="result__snippet">This is an organic snippet from DDG without any key.</a>
      </div>
    `;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockHtml,
    });

    const res = await afotWebSearch('zero key query');
    expect(res.provider).toBe('duckduckgo');
    expect(res.results).toHaveLength(1);
    expect(res.results[0].title).toBe('DuckDuckGo Organic Result');
    expect(res.results[0].url).toBe('https://example.com/ddg');
    expect(res.results[0].snippet).toContain('organic snippet');
  });
});

describe('afotWebExtract', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('TINYFISH_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  it('should return null when no extraction provider keys are configured', async () => {
    const res = await afotWebExtract('https://example.com/page');
    expect(res).toBeNull();
  });

  it('should extract clean Markdown via Firecrawl when FIRECRAWL_API_KEY is configured', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-key');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          markdown: '# Extracted Title\n\nClean markdown body without ads or nav.',
          metadata: { title: 'Extracted Title' },
        },
      }),
    });

    const res = await afotWebExtract('https://example.com/deep-page');
    expect(res).not.toBeNull();
    expect(res?.provider).toBe('firecrawl');
    expect(res?.contentType).toBe('text/markdown');
    expect(res?.content).toContain('# Extracted Title');
  });

  it('should extract via native clean reader when called directly', async () => {
    const html = `
      <html>
        <head><title>Native Clean Test</title><style>.ad{color:red}</style></head>
        <body>
          <nav><a href="/home">Home</a></nav>
          <header><h1>Site Header</h1></header>
          <main>
            <h2>Real Article</h2>
            <p>This is the core content of the page.</p>
          </main>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => html,
    });

    isPrivateIpMock.mockResolvedValue(false);
    const res = await extractNativeClean('https://example.com/article');
    expect(res.provider).toBe('native-reader');
    expect(res.content.toUpperCase()).toContain('REAL ARTICLE');
    expect(res.content).toContain('This is the core content');
    // Nav and footer should be stripped
    expect(res.content).not.toContain('Site Header');
    expect(res.content).not.toContain('Copyright 2026');
  });

  it('native reader refuses private/local addresses without fetching', async () => {
    isPrivateIpMock.mockResolvedValue(true);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    await expect(extractNativeClean('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private or local/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('native reader rejects non-http(s) schemes', async () => {
    isPrivateIpMock.mockResolvedValue(false);
    globalThis.fetch = vi.fn();
    await expect(extractNativeClean('file:///etc/passwd')).rejects.toThrow(/http/);
  });

  it('native reader does not follow redirects (they could point at internal hosts)', async () => {
    isPrivateIpMock.mockResolvedValue(false);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'http://127.0.0.1/admin' }),
      text: async () => '',
    });
    globalThis.fetch = fetchMock;
    await expect(extractNativeClean('https://example.com/r')).rejects.toThrow(/Redirect/);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
  });
});
