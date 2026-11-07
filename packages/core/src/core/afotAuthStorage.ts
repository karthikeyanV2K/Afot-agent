/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AFOT Auth Storage
 *
 * Completely independent auth system. Reads provider credentials from
 * ~/.afot/auth.json and provider configuration from ~/.afot/config.json.
 *
 * This is isolated from OpenCode, Gemini CLI keychain, and all Google auth.
 *
 * auth.json format (credentials — never commit this):
 * {
 *   "openrouter": { "type": "api", "key": "sk-or-v1-..." },
 *   "nvidia":     { "type": "api", "key": "nvapi-..." }
 * }
 *
 * config.json format (provider definitions):
 * {
 *   "providers": {
 *     "openrouter": {
 *       "baseUrl": "https://openrouter.ai/api/v1",
 *       "models": ["anthropic/claude-opus-4", "google/gemini-2.5-pro"]
 *     },
 *     "nvidia": {
 *       "baseUrl": "https://integrate.api.nvidia.com/v1",
 *       "models": ["nvidia/llama-3.1-nemotron-70b-instruct"]
 *     }
 *   },
 *   "defaultProvider": "openrouter"
 * }
 *
 * Provider resolution order:
 *   1. AFOT_PROVIDER env var
 *   2. config.json "defaultProvider"
 *   3. First entry in auth.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { debugLogger } from '../utils/debugLogger.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

/**
 * Returns the ~/.afot directory path.
 * Override with AFOT_HOME env var.
 */
export function getAfotDir(): string {
  return process.env['AFOT_HOME'] ?? path.join(os.homedir(), '.afot');
}

export function getAfotAuthFilePath(): string {
  return path.join(getAfotDir(), 'auth.json');
}

export function getAfotConfigFilePath(): string {
  return path.join(getAfotDir(), 'config.json');
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AfotApiAuth {
  type: 'api';
  key: string;
}

export interface AfotOAuthAuth {
  type: 'oauth';
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  [key: string]: unknown;
}

export type AfotAuthEntry = AfotApiAuth | AfotOAuthAuth;

export interface AfotAuthFile {
  [providerName: string]: AfotAuthEntry;
}

export interface AfotProviderConfig {
  /** Base URL for the provider's API endpoint */
  baseUrl: string;
  /** List of model IDs available from this provider */
  models?: string[];
  /** Extra HTTP headers to send to this provider */
  headers?: Record<string, string>;
}

export interface AfotConfig {
  providers?: Record<string, AfotProviderConfig>;
  /** Name of the provider to use by default (matches a key in auth.json) */
  defaultProvider?: string;
  /** Default model ID to use (e.g. "google/gemini-2.5-pro" for openrouter) */
  defaultModel?: string;
  /** Web search provider config */
  websearch?: {
    /** 'auto' tries providers in order until one works, 'random' rotates */
    provider?: 'auto' | 'random' | 'brave' | 'serper' | 'tavily' | 'none';
    braveApiKey?: string;
    serperApiKey?: string;
    tavilyApiKey?: string;
  };
  /** Tool output size limits */
  toolLimits?: {
    maxOutputLines?: number;
    maxOutputBytes?: number;
  };
  /** Context compaction settings */
  compaction?: {
    auto?: boolean;
    keepTokens?: number;
    bufferPercent?: number;
  };
  /** Session warming — periodic silent requests to prevent cold starts */
  warming?: {
    enabled?: boolean;
    intervalSeconds?: number;
  };
  /** Named external references (dirs or git repos) injected as context */
  references?: Record<string, { path?: string; url?: string; branch?: string }>;
  /** Plugin file paths or npm package names */
  plugins?: string[];
}

/** Fully resolved, ready-to-use provider credentials + config */
export interface AfotResolvedProvider {
  name: string;
  key: string;
  baseUrl: string;
  headers?: Record<string, string>;
  models?: string[];
  /** The default model to use with this provider */
  defaultModel?: string;
}

// ─── File readers ─────────────────────────────────────────────────────────────

function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as T;
    }
    debugLogger.warn(`AFOT: ${filePath} has unexpected format`);
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.warn(`AFOT: Failed to read ${filePath}: ${err}`);
    }
    return null;
  }
}

export function readAfotAuthFile(): AfotAuthFile | null {
  return readJsonFile<AfotAuthFile>(getAfotAuthFilePath());
}

export function readAfotConfig(): AfotConfig | null {
  return readJsonFile<AfotConfig>(getAfotConfigFilePath());
}

// ─── Provider resolution ──────────────────────────────────────────────────────

/**
 * Lists all provider names that have a valid api-type entry in auth.json.
 */
export function listAfotProviders(): string[] {
  const authFile = readAfotAuthFile();
  if (!authFile) return [];
  return Object.entries(authFile)
    .filter(
      ([, entry]) => entry.type === 'api' && (entry as AfotApiAuth).key?.trim(),
    )
    .map(([name]) => name);
}

/**
 * Returns all known providers with their status:
 * - configured: has a non-empty key in auth.json
 * - baseUrl from config.json
 * - models from config.json
 */
export function getAllAfotProviderStatus(): Array<{
  name: string;
  configured: boolean;
  baseUrl: string;
  models: string[];
  isLocal: boolean;
}> {
  const authFile = readAfotAuthFile() ?? {};
  const config = readAfotConfig();

  // Merge builtin definitions with any user-added ones
  const allNames = new Set([
    ...Object.keys(BUILTIN_PROVIDERS),
    ...Object.keys(authFile),
    ...Object.keys(config?.providers ?? {}),
  ]);

  return Array.from(allNames).map((name) => {
    const authEntry = authFile[name];
    const key =
      authEntry?.type === 'api' ? (authEntry as AfotApiAuth).key?.trim() : '';
    const provConfig =
      config?.providers?.[name] ?? BUILTIN_PROVIDERS[name];
    return {
      name,
      configured: !!key,
      baseUrl: provConfig?.baseUrl ?? '',
      models: provConfig?.models ?? BUILTIN_PROVIDERS[name]?.models ?? [],
      isLocal: LOCAL_PROVIDERS.has(name),
    };
  });
}

/**
 * Resolves the active provider using this priority:
 *   1. AFOT_PROVIDER env var
 *   2. config.json defaultProvider
 *   3. First api-type entry in auth.json
 *
 * Returns null if no usable provider is found.
 */
export function resolveAfotProvider(): AfotResolvedProvider | null {
  const authFile = readAfotAuthFile();
  if (!authFile) return null;

  const config = readAfotConfig();

  // Determine which provider name to use
  const candidates: string[] = [];

  const envProvider = process.env['AFOT_PROVIDER']?.trim();
  if (envProvider) candidates.push(envProvider);

  if (config?.defaultProvider?.trim()) {
    candidates.push(config.defaultProvider.trim());
  }

  // Add all api-type providers as fallbacks
  for (const [name, entry] of Object.entries(authFile)) {
    if (entry.type === 'api' && (entry as AfotApiAuth).key?.trim()) {
      candidates.push(name);
    }
  }

  for (const name of candidates) {
    const authEntry = authFile[name];
    if (!authEntry || authEntry.type !== 'api') continue;

    const key = (authEntry as AfotApiAuth).key?.trim();
    if (!key) continue;

    const providerConfig = config?.providers?.[name];

    // baseUrl: config.json entry wins, otherwise require it to be present
    const baseUrl = providerConfig?.baseUrl?.trim();
    if (!baseUrl) {
      debugLogger.warn(
        `AFOT: Provider "${name}" has no baseUrl in ~/.afot/config.json — skipping`,
      );
      continue;
    }

    return {
      name,
      key,
      baseUrl,
      headers: providerConfig?.headers,
      models: providerConfig?.models,
      defaultModel: config?.defaultModel?.trim() || providerConfig?.models?.[0],
    };
  }

  return null;
}

/**
 * Validates the AFOT auth setup and returns an error string if invalid,
 * or null if everything is ready to use.
 */
export function validateAfotAuth(): string | null {
  const authPath = getAfotAuthFilePath();
  const configPath = getAfotConfigFilePath();

  const authFile = readAfotAuthFile();
  if (!authFile) {
    return (
      `AFOT auth file not found at: ${authPath}\n` +
      `Create it with at least one provider entry:\n` +
      `{\n` +
      `  "myprovider": { "type": "api", "key": "your-api-key" }\n` +
      `}\n` +
      `Also create ${configPath} with the provider's baseUrl.`
    );
  }

  const providers = listAfotProviders();
  if (providers.length === 0) {
    return (
      `No valid api-type providers found in ${authPath}.\n` +
      `Add at least one entry:\n` +
      `  "myprovider": { "type": "api", "key": "your-api-key" }`
    );
  }

  const resolved = resolveAfotProvider();
  if (!resolved) {
    return (
      `Found providers in auth.json (${providers.join(', ')}) but none have a baseUrl in ${configPath}.\n` +
      `Add provider config:\n` +
      `{\n` +
      `  "providers": {\n` +
      `    "${providers[0]}": { "baseUrl": "https://your-provider.com/v1" }\n` +
      `  }\n` +
      `}`
    );
  }

  return null;
}

// ─── Built-in provider definitions (no keys — keys come from installer/user) ──

/**
 * The canonical list of all supported providers with their base URLs and
 * known model IDs. Keys are intentionally empty — they are filled in either
 * by the interactive installer (`afot setup`) or manually by the user.
 * Providers whose keys remain empty are skipped by resolveAfotProvider().
 */
export const BUILTIN_PROVIDERS: Record<
  string,
  { baseUrl: string; models: string[] }
> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'anthropic/claude-opus-4',
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-haiku-3-5',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'openai/gpt-4o',
      'openai/gpt-4.1',
      'openai/o3',
      'openai/o4-mini',
      'deepseek/deepseek-r1',
      'meta-llama/llama-4-maverick',
      'mistralai/mistral-large-2411',
      'qwen/qwen3-235b-a22b',
      'x-ai/grok-3-beta',
    ],
  },
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'meta/llama-4-maverick-17b-128e-instruct',
      'deepseek-ai/deepseek-r1-0528',
    ],
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-opus-4-0', 'claude-sonnet-4-5', 'claude-haiku-3-5'],
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini'],
  },
  'google-ai': {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
    ],
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'moonshotai/kimi-k2-instruct',
      'qwen/qwen3-32b',
      'deepseek-r1-distill-llama-70b',
      'compound-beta',
    ],
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    models: [
      'mistral-large-latest',
      'mistral-medium-latest',
      'codestral-latest',
      'devstral-small-latest',
    ],
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    models: [
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3-235B-A22B-fp8-tput',
    ],
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-3-beta', 'grok-3-fast-beta', 'grok-3-mini-beta'],
  },
  cohere: {
    baseUrl: 'https://api.cohere.com/v2',
    models: ['command-a-03-2025', 'command-r-plus-08-2024'],
  },
  perplexity: {
    baseUrl: 'https://api.perplexity.ai',
    models: [
      'sonar-pro',
      'sonar',
      'sonar-reasoning-pro',
      'sonar-deep-research',
    ],
  },
  zai: {
    baseUrl: 'https://api.z.ai/v1',
    models: ['glm-4.5', 'glm-4.5-air', 'glm-z1-flash'],
  },
  'cline-pass': {
    baseUrl: 'https://api.cline.bot/v1',
    models: ['claude-opus-4-0', 'claude-sonnet-4-5', 'gpt-4o', 'deepseek-r1'],
  },
  // Local providers — no real key needed
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.3:latest', 'qwen3:30b', 'deepseek-r1:14b', 'gemma3:27b'],
  },
  lmstudio: {
    baseUrl: 'http://localhost:1234/v1',
    models: [],
  },
};

/** Local providers that use a placeholder key (not a real secret). */
export const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

/**
 * Generates a blank auth.json with all known provider slots and empty keys.
 * No real credentials are embedded here — keys are filled by the installer
 * or directly by the user.
 */
export function generateBlankAuthFile(): AfotAuthFile {
  const blank: AfotAuthFile = {};
  for (const [name] of Object.entries(BUILTIN_PROVIDERS)) {
    // Local providers get a static placeholder so they work without a key
    blank[name] = {
      type: 'api',
      key: LOCAL_PROVIDERS.has(name) ? name : '',
    };
  }
  return blank;
}

/**
 * Generates a blank config.json with all known provider definitions.
 * No keys — those live in auth.json only.
 */
export function generateDefaultConfigFile(): AfotConfig {
  const providers: Record<string, AfotProviderConfig> = {};
  for (const [name, def] of Object.entries(BUILTIN_PROVIDERS)) {
    providers[name] = { baseUrl: def.baseUrl, models: def.models };
  }
  return {
    defaultProvider: 'openrouter',
    providers,
    websearch: { provider: 'auto', braveApiKey: '', serperApiKey: '', tavilyApiKey: '' },
    toolLimits: { maxOutputLines: 2000, maxOutputBytes: 51200 },
    compaction: { auto: true, keepTokens: 8000, bufferPercent: 10 },
    warming: { enabled: false, intervalSeconds: 300 },
    references: {},
    plugins: [],
  };
}

/**
 * Writes a single provider's API key into ~/.afot/auth.json.
 * Used by the installer and by the `/provider set-key` command.
 * Creates the file if it doesn't exist yet.
 */
export function setAfotProviderKey(providerName: string, key: string): void {
  ensureAfotDir();
  const authPath = getAfotAuthFilePath();
  let authFile = readAfotAuthFile() ?? generateBlankAuthFile();
  authFile[providerName] = { type: 'api', key };
  fs.writeFileSync(authPath, JSON.stringify(authFile, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  debugLogger.log(`AFOT: Key saved for provider "${providerName}"`);
}

/**
 * Sets the default provider in ~/.afot/config.json at runtime.
 * Used by the `/provider` slash command.
 */
export function setAfotDefaultProvider(providerName: string): void {
  ensureAfotDir();
  const configPath = getAfotConfigFilePath();
  const config = readAfotConfig() ?? generateDefaultConfigFile();
  config.defaultProvider = providerName;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  debugLogger.log(`AFOT: Default provider set to "${providerName}"`);
}

/**
 * Creates the ~/.afot directory and scaffold files if they don't exist.
 * Safe to call multiple times.
 *
 * This does NOT embed any API keys — keys are set either by the installer
 * (`afot setup`) or manually by the user editing ~/.afot/auth.json.
 */
export function ensureAfotDir(): void {
  const dir = getAfotDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const authPath = getAfotAuthFilePath();
  if (!fs.existsSync(authPath)) {
    const blank = generateBlankAuthFile();
    fs.writeFileSync(authPath, JSON.stringify(blank, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600, // owner read/write only — credentials are sensitive
    });
    debugLogger.log(`AFOT: Created blank auth.json at ${authPath}`);
  }

  const configPath = getAfotConfigFilePath();
  if (!fs.existsSync(configPath)) {
    const defaultConfig = generateDefaultConfigFile();
    fs.writeFileSync(
      configPath,
      JSON.stringify(defaultConfig, null, 2) + '\n',
      'utf8',
    );
    debugLogger.log(`AFOT: Created default config.json at ${configPath}`);
  }
}
