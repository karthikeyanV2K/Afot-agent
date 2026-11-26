/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider auto-discovery and rate-limit classification for OpenAI-compatible
 * free/low-tier APIs (Groq, Cerebras, GitHub Models, ...).
 */

/**
 * Env vars that supply an API key for a provider without touching auth.json.
 * Deliberately excludes variables that are usually set for *other* tools and
 * bill per token (OPENAI_API_KEY, ANTHROPIC_API_KEY) or are broadly scoped
 * (HF_TOKEN, GITHUB_TOKEN): AFOT must not start sending code to those by
 * surprise. Use AFOT_<NAME>_API_KEY to opt those in explicitly.
 */
export const PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  openrouter: ['OPENROUTER_API_KEY'],
  nvidia: ['NVIDIA_API_KEY', 'NGC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  sambanova: ['SAMBANOVA_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  hyperbolic: ['HYPERBOLIC_API_KEY'],
  github: ['GITHUB_MODELS_TOKEN'],
  huggingface: ['HUGGINGFACE_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  xai: ['XAI_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  zai: ['ZAI_API_KEY'],
};

/**
 * Key for a provider from the environment: the well-known variable(s) above,
 * or AFOT_<NAME>_API_KEY for any provider name (non-alphanumerics -> "_").
 */
export function getEnvProviderKey(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const generic = `AFOT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  for (const v of [generic, ...(PROVIDER_ENV_KEYS[name] ?? [])]) {
    const val = env[v]?.trim();
    if (val) return val;
  }
  return undefined;
}

/** Names of providers that have a usable key in the environment. */
export function listEnvProviders(
  extraNames: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const names = new Set([...Object.keys(PROVIDER_ENV_KEYS), ...extraNames]);
  return [...names].filter((n) => getEnvProviderKey(n, env) !== undefined);
}

/**
 * Parses "try again in 7m12.5s", "in 2.5s", "in 350ms", "resets in 2h" into
 * seconds. Returns undefined when nothing parseable is present.
 */
export function parseRetryDelaySeconds(message: string): number | undefined {
  const m = message.match(
    /(?:try again|retry|resets?|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/i,
  );
  if (!m) return undefined;
  let total = 0;
  for (const part of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
    const v = parseFloat(part[1]);
    const u = part[2].toLowerCase();
    total +=
      u === 'ms' ? v / 1000 : u === 's' ? v : u === 'm' ? v * 60 : v * 3600;
  }
  return total > 0 ? Math.ceil(total) : undefined;
}

export type RateLimitKind = 'retryable' | 'terminal' | 'too_large';

export interface RateLimitVerdict {
  kind: RateLimitKind;
  retryAfterSeconds?: number;
}

/** A short per-minute limit is worth waiting out; a daily/plan quota is not. */
export const MAX_AUTO_WAIT_SECONDS = 90;

/**
 * Classifies a 429/413 from an OpenAI-compatible provider.
 * - too_large: this single request can never fit (Groq "Requested 9000 > Limit 6000",
 *   HTTP 413, "request too large"). Retrying is pointless; shrink the prompt.
 * - retryable: short rate window (RPM/TPM), wait retryAfter and try again.
 * - terminal: daily/monthly/plan quota or a long wait.
 */
export function classifyRateLimit(
  status: number | undefined,
  message: string,
  retryAfterHeaderSeconds?: number,
): RateLimitVerdict {
  const msg = message || '';
  const req = msg.match(/requested\s+(\d+)/i);
  const lim = msg.match(/limit[:\s]+(\d+)/i);
  if (
    status === 413 ||
    /request too large|payload too large|context[_ ]length|maximum context/i.test(
      msg,
    ) ||
    (req && lim && Number(req[1]) > Number(lim[1]))
  ) {
    return { kind: 'too_large' };
  }
  const retryAfter = retryAfterHeaderSeconds ?? parseRetryDelaySeconds(msg);
  const longWindow =
    /per day|daily|\bRPD\b|\bTPD\b|per month|monthly|free usage limit|usage limit reached|insufficient[_ ]quota|exceeded your current quota|billing/i.test(
      msg,
    );
  if (longWindow) return { kind: 'terminal', retryAfterSeconds: retryAfter };
  if (retryAfter !== undefined && retryAfter > MAX_AUTO_WAIT_SECONDS) {
    return { kind: 'terminal', retryAfterSeconds: retryAfter };
  }
  return { kind: 'retryable', retryAfterSeconds: retryAfter ?? 5 };
}
