/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyRateLimit,
  getEnvProviderKey,
  listEnvProviders,
  parseRetryDelaySeconds,
} from './afotProviderDiscovery.js';
import {
  getAllAfotProviderStatus,
  listAfotProviders,
  resolveAfotProvider,
  resolveAfotProviderByName,
  BUILTIN_PROVIDERS,
} from './afotAuthStorage.js';
import { AfotOpenAIContentGenerator } from './afotOpenAIContentGenerator.js';
import {
  RetryableQuotaError,
  TerminalQuotaError,
} from '../utils/googleQuotaErrors.js';
import { LlmRole } from '../telemetry/llmRole.js';

describe('parseRetryDelaySeconds', () => {
  it.each([
    ['Please try again in 2.5s.', 3],
    ['try again in 7m12.5s', 433],
    ['Please retry after 350ms', 1],
    ['quota resets in 2h', 7200],
    ['try again in 1m', 60],
  ])('%s', (msg, secs) => {
    expect(parseRetryDelaySeconds(msg)).toBe(secs);
  });
  it('returns undefined when absent', () => {
    expect(parseRetryDelaySeconds('Rate limit reached')).toBeUndefined();
  });
});

describe('classifyRateLimit', () => {
  it('short window is retryable', () => {
    expect(
      classifyRateLimit(
        429,
        'Rate limit reached for model x. Please try again in 2.5s',
      ),
    ).toEqual({ kind: 'retryable', retryAfterSeconds: 3 });
  });
  it('header wins and default wait applies when nothing is given', () => {
    expect(classifyRateLimit(429, 'slow down', 12)).toEqual({
      kind: 'retryable',
      retryAfterSeconds: 12,
    });
    expect(classifyRateLimit(429, 'slow down')).toEqual({
      kind: 'retryable',
      retryAfterSeconds: 5,
    });
  });
  it('daily / plan quota and long waits are terminal', () => {
    expect(
      classifyRateLimit(429, 'Rate limit reached ... tokens per day (TPD)')
        .kind,
    ).toBe('terminal');
    expect(
      classifyRateLimit(429, 'You exceeded your current quota, check billing')
        .kind,
    ).toBe('terminal');
    expect(classifyRateLimit(429, 'try again in 2h').kind).toBe('terminal');
    expect(classifyRateLimit(429, 'x', 3600).kind).toBe('terminal');
  });
  it('a request that can never fit is too_large, not retryable', () => {
    expect(
      classifyRateLimit(
        429,
        'Limit 6000, Requested 9300, tokens per minute (TPM)',
      ).kind,
    ).toBe('too_large');
    expect(classifyRateLimit(413, 'whatever').kind).toBe('too_large');
    expect(
      classifyRateLimit(400, "This model's maximum context length is 8192")
        .kind,
    ).toBe('too_large');
  });
});

describe('env provider keys', () => {
  it('reads well-known and generic variables', () => {
    const env = { GROQ_API_KEY: ' gk ', AFOT_MY_HOST_API_KEY: 'mk' };
    expect(getEnvProviderKey('groq', env)).toBe('gk');
    expect(getEnvProviderKey('my-host', env)).toBe('mk');
    expect(getEnvProviderKey('cerebras', env)).toBeUndefined();
  });
  it('never auto-detects broad/paid-by-default variables', () => {
    const env = {
      OPENAI_API_KEY: 'x',
      ANTHROPIC_API_KEY: 'x',
      HF_TOKEN: 'x',
      GITHUB_TOKEN: 'x',
    };
    expect(
      listEnvProviders(['openai', 'anthropic', 'huggingface', 'github'], env),
    ).toEqual([]);
    expect(getEnvProviderKey('openai', { AFOT_OPENAI_API_KEY: 'k' })).toBe('k');
  });
});

describe('provider resolution with env keys', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'afot-disc-'));
    vi.stubEnv('AFOT_HOME', home);
    vi.stubEnv('AFOT_PROVIDER', '');
    for (const v of ['GROQ_API_KEY', 'CEREBRAS_API_KEY']) vi.stubEnv(v, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('works with no auth.json at all', () => {
    expect(resolveAfotProvider()).toBeNull();
    vi.stubEnv('GROQ_API_KEY', 'gsk_env');
    const p = resolveAfotProvider();
    expect(p).toMatchObject({
      name: 'groq',
      key: 'gsk_env',
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-3.3-70b-versatile',
    });
    expect(resolveAfotProviderByName('groq')?.key).toBe('gsk_env');
    expect(listAfotProviders()).toContain('groq');
    expect(
      getAllAfotProviderStatus().find((x) => x.name === 'groq')?.configured,
    ).toBe(true);
  });

  it('auth.json key wins over the environment and env keys are not written to disk', () => {
    fs.writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({ groq: { type: 'api', key: 'from-file' } }),
    );
    vi.stubEnv('GROQ_API_KEY', 'from-env');
    expect(resolveAfotProviderByName('groq')?.key).toBe('from-file');
    vi.stubEnv('CEREBRAS_API_KEY', 'c-env');
    expect(resolveAfotProviderByName('cerebras')?.key).toBe('c-env');
    expect(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).not.toContain(
      'c-env',
    );
  });

  it('ships the new free-tier presets', () => {
    for (const n of [
      'groq',
      'cerebras',
      'sambanova',
      'fireworks',
      'hyperbolic',
      'github',
      'huggingface',
    ]) {
      expect(BUILTIN_PROVIDERS[n]?.baseUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('generator rate-limit handling', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'afot-rl-'));
    vi.stubEnv('AFOT_HOME', home);
    vi.stubEnv('AFOT_FAILOVER', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = async (name: string, error: object) => {
    const gen = new AfotOpenAIContentGenerator(
      {
        name,
        key: 'k',
        baseUrl: 'https://x/v1',
        models: ['m'],
        defaultModel: 'm',
      },
      'm',
    );
    const create = vi.fn().mockRejectedValue(error);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gen as any).client = { chat: { completions: { create } } };
    const err = await gen
      .generateContent(
        { model: 'm', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        'p',
        LlmRole.MAIN,
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    return { err, gen };
  };

  it('Groq per-minute 429 is retryable with the server delay', async () => {
    const { err } = await run('groq', {
      status: 429,
      message: 'Rate limit reached for model m. Please try again in 4.2s',
    });
    expect(err).toBeInstanceOf(RetryableQuotaError);
    expect((err as RetryableQuotaError).retryDelayMs).toBe(5000);
  });

  it('daily quota stays terminal', async () => {
    const { err } = await run('groq', {
      status: 429,
      message: 'Rate limit reached ... tokens per day (TPD): Limit 100000',
    });
    expect(err).toBeInstanceOf(TerminalQuotaError);
  });

  it('too-large request switches to Eco and says so', async () => {
    const { err, gen } = await run('groq', {
      status: 413,
      message: 'Request too large for model m ... Limit 6000, Requested 9300',
    });
    expect(String((err as Error).message)).toMatch(/too large/i);
    expect(String((err as Error).message)).toMatch(/Eco/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gen as any).forceEco).toBe(true);
  });

  it('OpenCode 429 keeps its terminal behaviour', async () => {
    const { err } = await run('opencode', {
      status: 429,
      message: 'slow down',
    });
    expect(err).toBeInstanceOf(TerminalQuotaError);
  });
});
