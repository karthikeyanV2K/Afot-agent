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

// ─── Safe file I/O ────────────────────────────────────────────────────────────

/**
 * Atomically writes a file: data goes to a temp file in the same directory and
 * is then renamed over the target, so readers never see a half-written file
 * and a crash can never leave a truncated auth.json behind.
 *
 * `mode` defaults to the existing file's mode (so we never loosen permissions
 * on files we don't own, e.g. other tools' credential files) or 0o600 for new
 * files. The final chmod also tightens files that were created earlier with
 * looser permissions (writeFileSync only applies `mode` on creation).
 */
export function atomicWriteFile(
  filePath: string,
  data: string,
  mode?: number,
): void {
  let effectiveMode = mode;
  if (effectiveMode === undefined) {
    try {
      effectiveMode = fs.statSync(filePath).mode & 0o777;
    } catch {
      effectiveMode = 0o600;
    }
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data, { encoding: 'utf8', mode: effectiveMode });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, effectiveMode);
    } catch {
      // chmod is best-effort (e.g. Windows)
    }
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Like readJsonFile, but distinguishes "file does not exist" (returns null)
 * from "file exists but is unreadable/corrupt" (throws). Writers must use this
 * so a transient read or parse failure can never be mistaken for an empty file
 * and cause every stored credential to be overwritten.
 */
function readJsonFileStrict<T extends object>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} has unexpected format; refusing to overwrite`);
  }
  // The shape of auth/config files is validated field by field by the readers;
  // here we only guarantee "a JSON object", which is what makes overwriting safe.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return parsed as T;
}

export function readAfotAuthFileStrict(): AfotAuthFile | null {
  return readJsonFileStrict<AfotAuthFile>(getAfotAuthFilePath());
}

export function readAfotConfigStrict(): AfotConfig | null {
  return readJsonFileStrict<AfotConfig>(getAfotConfigFilePath());
}

function envFlag(name: string): boolean | undefined {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

/**
 * Cross-provider failover re-sends the whole conversation to a *different*
 * provider, so it is strictly opt-in (AFOT_FAILOVER=1 or config.failover=true).
 */
export function isAfotFailoverEnabled(
  config: AfotConfig | null = readAfotConfig(),
): boolean {
  return envFlag('AFOT_FAILOVER') ?? config?.failover === true;
}

/**
 * Parsing tool calls out of model *text* (DSML / XML / minimax) is needed by
 * some models but can be abused by prompt injection. On by default, can be
 * disabled with AFOT_EMBEDDED_TOOL_CALLS=0 or config.embeddedToolCalls=false.
 */
export function isAfotEmbeddedToolParsingEnabled(
  config: AfotConfig | null = readAfotConfig(),
): boolean {
  return (
    envFlag('AFOT_EMBEDDED_TOOL_CALLS') ?? config?.embeddedToolCalls !== false
  );
}

/** Plugins execute arbitrary JS, so they are strictly opt-in. */
export function isAfotPluginsEnabled(
  config: AfotConfig | null = readAfotConfig(),
): boolean {
  return envFlag('AFOT_PLUGINS') ?? config?.pluginsEnabled === true;
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
  /** Explicitly selected live model for this provider */
  defaultModel?: string;
  /** Extra HTTP headers to send to this provider */
  headers?: Record<string, string>;
}

export interface AfotPermissionsConfig {
  /** Auto-approve all subagent actions and tool executions without interactive confirmation */
  autoApprove?: boolean;
  /** Auto-approve shell execution commands */
  autoApproveShell?: boolean;
  /** Auto-approve workspace file edits and writes */
  autoApproveWorkspaceWrites?: boolean;
  /** Allow access to any directory outside the session root without interactive prompts */
  allowAllPaths?: boolean;
  /** List of additional directory paths permitted for file access and shell execution */
  allowedPaths?: string[];
  /**
   * Shell approval mode. 'workspace' runs commands that stay inside the
   * workspace without a prompt, but still asks for deletes, git reverts/resets,
   * and anything touching paths outside the workspace. Default 'ask'.
   */
  shellApproval?: AfotShellApprovalMode;
}

export type AfotShellApprovalMode = 'ask' | 'workspace';

export interface AfotConfig {
  providers?: Record<string, AfotProviderConfig>;
  /** Default approval mode (e.g. "yolo", "auto_edit", "plan", "default") */
  approvalMode?: string;
  /** Global auto-approval setting across all subagent tools and shell executions */
  autoApprove?: boolean;
  /** Auto-approve shell execution commands */
  autoApproveShell?: boolean;
  /** Show tool/shell output in full (no "N lines hidden"). Default true. */
  fullOutput?: boolean;
  /** Live monitor panel: off | compact | expanded. Default off. */
  monitor?: string;
  /** Auto-approve workspace file edits and writes */
  autoApproveWorkspaceWrites?: boolean;
  /** Allow access to any directory outside current working directory without prompts */
  allowAllPaths?: boolean;
  /** Specific extra allowed directory paths */
  allowedPaths?: string[];
  /** Shell approval mode ('ask' | 'workspace'). See AfotPermissionsConfig. */
  shellApproval?: AfotShellApprovalMode;
  /** Structured permissions settings */
  permissions?: AfotPermissionsConfig;
  /** Name of the provider to use by default (matches a key in auth.json) */
  defaultProvider?: string;
  /** Default model ID to use (e.g. "google/gemini-2.5-pro" for openrouter) */
  defaultModel?: string;
  /**
   * Token optimization / Eco Mode.
   * - 'auto' (default): automatically enabled for free models (ending in -free) and opencode provider.
   * - true: always enabled.
   * - false: disabled.
   */
  ecoMode?: boolean | 'auto';
  /** Web search provider config */
  websearch?: {
    /** 'auto' tries providers in order until one works, 'random' rotates, or specific provider */
    provider?:
      | 'auto'
      | 'random'
      | 'exa'
      | 'firecrawl'
      | 'parallel'
      | 'tavily'
      | 'tinyfish'
      | 'brave'
      | 'serper'
      | 'duckduckgo'
      | 'none';
    exaApiKey?: string;
    firecrawlApiKey?: string;
    parallelApiKey?: string;
    tavilyApiKey?: string;
    tinyfishApiKey?: string;
    braveApiKey?: string;
    serperApiKey?: string;
    /** Preferred extraction provider for deep content reading (web_fetch) */
    extractProvider?:
      | 'auto'
      | 'firecrawl'
      | 'tavily'
      | 'exa'
      | 'tinyfish'
      | 'native';
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
  /**
   * Allow loading JS plugins from ~/.afot/plugins and `plugins` paths.
   * Plugins run with full user privileges, so this defaults to false.
   */
  pluginsEnabled?: boolean;
  /**
   * Allow re-sending a failed request (full conversation) to another configured
   * provider. Defaults to false: your code and context only go to the provider
   * you selected.
   */
  failover?: boolean;
  /** Parse tool calls embedded in model text (DSML/XML). Defaults to true. */
  embeddedToolCalls?: boolean;
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

/**
 * Checks whether Eco Mode is active for a given provider and model.
 * In Eco Mode, tool schemas are minified, conversational fast-paths are used,
 * and system prompts are compressed to save up to 99% of input tokens.
 */
export function isEcoModeActive(
  config: AfotConfig | null,
  providerName?: string,
  modelName?: string,
): boolean {
  if (
    process.env['AFOT_ECO_MODE'] === 'true' ||
    process.env['AFOT_ECO_MODE'] === '1'
  )
    return true;
  if (
    process.env['AFOT_ECO_MODE'] === 'false' ||
    process.env['AFOT_ECO_MODE'] === '0'
  )
    return false;
  const eco = config?.ecoMode ?? 'auto';
  if (eco === true) return true;
  if (eco === false) return false;
  // 'auto' mode: active for free models or opencode provider
  const prov = (providerName || '').toLowerCase();
  const mod = (modelName || '').toLowerCase();
  if (prov === 'opencode') return true;
  if (
    mod.endsWith('-free') ||
    mod.endsWith(':free') ||
    mod.includes('-free-') ||
    mod.includes(':free-')
  ) {
    return true;
  }
  return false;
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
    const oauthToken =
      authEntry?.type === 'oauth'
        ? (authEntry as AfotOAuthAuth).access_token?.trim()
        : '';
    const provConfig = config?.providers?.[name] ?? BUILTIN_PROVIDERS[name];
    const baseUrl =
      provConfig?.baseUrl ||
      (name === 'opencode'
        ? authEntry?.type === 'oauth' && (authEntry as AfotOAuthAuth)['server']
          ? String((authEntry as AfotOAuthAuth)['server'])
          : 'https://opencode.ai/console'
        : BUILTIN_PROVIDERS[name]?.baseUrl || '');
    return {
      name,
      configured: !!key || !!oauthToken,
      baseUrl,
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

  const rawAgent = (config as unknown as Record<string, unknown>)?.['agent'] as
    | Record<string, unknown>
    | undefined;
  const configuredProvider =
    config?.defaultProvider?.trim() ||
    (typeof rawAgent?.['default_provider'] === 'string'
      ? rawAgent['default_provider'].trim()
      : undefined);

  if (configuredProvider) {
    candidates.push(configuredProvider);
  }

  // Add all authenticated providers as fallbacks
  for (const [name, entry] of Object.entries(authFile)) {
    if (entry.type === 'api' && (entry as AfotApiAuth).key?.trim()) {
      candidates.push(name);
    }
    if (
      entry.type === 'oauth' &&
      (entry as AfotOAuthAuth).access_token?.trim()
    ) {
      candidates.push(name);
    }
  }

  for (const name of candidates) {
    const authEntry = authFile[name];
    if (!authEntry) continue;

    const key =
      authEntry.type === 'api'
        ? (authEntry as AfotApiAuth).key?.trim()
        : (authEntry as AfotOAuthAuth).access_token?.trim();
    if (!key) continue;

    const providerConfig = config?.providers?.[name];
    const oauthServer =
      authEntry.type === 'oauth'
        ? (authEntry as AfotOAuthAuth)['server']
        : undefined;
    const server =
      typeof oauthServer === 'string' && oauthServer.trim()
        ? oauthServer.trim()
        : 'https://opencode.ai/console';

    const baseUrl =
      providerConfig?.baseUrl?.trim() ||
      (name === 'opencode'
        ? `${server.replace(/\/+$/, '')}/ai/v1`
        : BUILTIN_PROVIDERS[name]?.baseUrl || '');
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
      models: providerConfig?.models ?? BUILTIN_PROVIDERS[name]?.models,
      defaultModel:
        providerConfig?.defaultModel?.trim() ||
        BUILTIN_PROVIDERS[name]?.defaultModel,
    };
  }

  return null;
}

export function resolveAfotProviderByName(
  providerName: string,
): AfotResolvedProvider | null {
  const authFile = readAfotAuthFile();
  const entry = authFile?.[providerName];
  if (!entry) return null;

  const config = readAfotConfig();
  const providerConfig = config?.providers?.[providerName];
  const key =
    entry.type === 'api'
      ? entry.key?.trim()
      : entry.type === 'oauth'
        ? entry.access_token?.trim()
        : '';
  if (!key) return null;

  const oauthServer =
    entry.type === 'oauth' ? (entry as AfotOAuthAuth)['server'] : undefined;
  const server =
    typeof oauthServer === 'string' && oauthServer.trim()
      ? oauthServer.trim()
      : 'https://opencode.ai/console';
  const baseUrl =
    providerConfig?.baseUrl?.trim() ||
    (providerName === 'opencode'
      ? `${server.replace(/\/+$/, '')}/ai/v1`
      : BUILTIN_PROVIDERS[providerName]?.baseUrl || '');
  if (!baseUrl) return null;

  return {
    name: providerName,
    key,
    baseUrl,
    headers: providerConfig?.headers,
    models: providerConfig?.models ?? BUILTIN_PROVIDERS[providerName]?.models,
    defaultModel:
      providerConfig?.defaultModel?.trim() ||
      BUILTIN_PROVIDERS[providerName]?.defaultModel,
  };
}

export function resolveAfotActiveProviderName(): string | null {
  const authFile = readAfotAuthFile();
  if (!authFile) return null;

  const envProvider = process.env['AFOT_PROVIDER']?.trim();
  if (envProvider) {
    const envEntry = authFile[envProvider];
    if (envEntry?.type === 'api' && (envEntry as AfotApiAuth).key?.trim())
      return envProvider;
    if (
      envEntry?.type === 'oauth' &&
      (envEntry as AfotOAuthAuth).access_token?.trim()
    )
      return envProvider;
  }

  const config = readAfotConfig();
  const rawAgentConfig = (config as unknown as Record<string, unknown>)?.[
    'agent'
  ] as Record<string, unknown> | undefined;
  const configured =
    config?.defaultProvider?.trim() ||
    (typeof rawAgentConfig?.['default_provider'] === 'string'
      ? rawAgentConfig['default_provider'].trim()
      : undefined);
  if (configured) {
    const configuredEntry = authFile[configured];
    if (
      configuredEntry?.type === 'api' &&
      (configuredEntry as AfotApiAuth).key?.trim()
    ) {
      return configured;
    }
    if (
      configuredEntry?.type === 'oauth' &&
      (configuredEntry as AfotOAuthAuth).access_token?.trim()
    ) {
      return configured;
    }
  }

  for (const [name, entry] of Object.entries(authFile)) {
    if (entry.type === 'api' && entry.key?.trim()) return name;
    if (entry.type === 'oauth' && entry.access_token?.trim()) return name;
  }
  return null;
}

export function filterAfotChatModels(models: readonly string[]): string[] {
  const excluded = [
    'embed',
    'embedding',
    'retriever',
    'retrieval',
    'rerank',
    'reward',
    'guardrail',
    'safety',
    'moderation',
    'nemoguard',
    'topic-control',
    'detector',
    'llama-guard',
    'clip',
    'calibration',
    'parse',
  ];
  return models.filter(
    (model) => !excluded.some((token) => model.toLowerCase().includes(token)),
  );
}

export function sortAfotModels(models: readonly string[]): string[] {
  return Array.from(new Set(models.filter((model) => model.trim()))).sort(
    (left, right) => left.localeCompare(right, undefined, { numeric: true }),
  );
}

export async function fetchAfotProviderModels(
  provider?: AfotResolvedProvider | null,
): Promise<string[]> {
  const resolved = provider ?? resolveAfotProvider();
  if (!resolved?.baseUrl) return [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(
      `${resolved.baseUrl.replace(/\/+$/, '')}/models`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${resolved.key}`,
          ...resolved.headers,
        },
        signal: controller.signal,
      },
    ).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      return Array.from(new Set(resolved.models ?? []));
    }
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown }>;
      models?: Record<string, unknown> | string[];
    };
    const ids = Array.isArray(body.data)
      ? body.data
          .map((model) => model.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (ids.length === 0 && Array.isArray(body.models)) {
      ids.push(
        ...body.models.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      );
    } else if (
      ids.length === 0 &&
      body.models &&
      typeof body.models === 'object'
    ) {
      ids.push(...Object.keys(body.models));
    }
    const filteredIds = filterAfotChatModels(ids);
    const configuredList = resolved.models ?? [];
    const configuredSet = new Set(configuredList);
    const extraLive = filteredIds
      .filter((id) => !configuredSet.has(id))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const combined = Array.from(new Set([...configuredList, ...extraLive]));
    return combined;
  } catch {
    return Array.from(new Set(resolved.models ?? []));
  }
}

const executableModelCache = new Map<string, string>();

export async function findExecutableAfotModel(
  provider: AfotResolvedProvider,
  models: readonly string[],
  limit = Number.POSITIVE_INFINITY,
): Promise<string | undefined> {
  const candidateModels = [
    ...(provider.defaultModel ? [provider.defaultModel] : []),
    ...models.filter((m) => m !== provider.defaultModel),
  ];

  if (candidateModels.length === 0) {
    return undefined;
  }

  if (provider.name !== 'nvidia' && provider.name !== 'openrouter') {
    return candidateModels[0] ?? models[0];
  }

  const cacheKey = `${provider.name}:${provider.key}`;
  const cached = executableModelCache.get(cacheKey);
  if (cached && models.includes(cached)) return cached;

  for (const model of candidateModels.slice(0, limit)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(
        `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${provider.key}`,
            ...provider.headers,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            max_tokens: 16,
            stream: false,
          }),
          signal: controller.signal,
        },
      );
      if (response.ok) {
        executableModelCache.set(cacheKey, model);
        return model;
      }
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 429
      ) {
        return candidateModels[0] ?? models[0];
      }
    } catch {
      // Try the next catalog entry; provider-specific 404s do not indicate availability of later models.
    } finally {
      clearTimeout(timeout);
    }
  }
  return candidateModels[0] ?? models[0];
}

export function setAfotProviderModels(
  providerName: string,
  models: string[],
  defaultModel?: string,
): void {
  if (models.length === 0) return;
  ensureAfotDir();
  const configPath = getAfotConfigFilePath();
  const config = readAfotConfigStrict() ?? generateDefaultConfigFile();
  config.providers = {
    ...(config.providers ?? {}),
    [providerName]: {
      ...(config.providers?.[providerName] ?? {}),
      baseUrl:
        config.providers?.[providerName]?.baseUrl ??
        BUILTIN_PROVIDERS[providerName]?.baseUrl ??
        '',
      models,
      ...(defaultModel ? { defaultModel } : {}),
    },
  };
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + '\n', 0o600);
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
  { baseUrl: string; models: string[]; defaultModel?: string }
> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'z-ai/glm-5.3-flash',
      'deepseek/deepseek-v4.1-flash',
      'deepseek/deepseek-chat',
      'moonshotai/kimi-k2.6',
      'z-ai/glm-4.5',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro',
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-opus-4',
      'anthropic/claude-haiku-3-5',
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
    defaultModel: 'z-ai/glm-5.3-flash',
  },
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      'nvidia/nemotron-3.5-super-vl-120b-a12b',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'nvidia/nemotron-3.5-bolt-e4b',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'poolside/laguna-xs-2.1',
      'deepseek-ai/deepseek-v4.1-flash',
      'deepseek-ai/deepseek-coder-6.7b-instruct',
      'nvidia/cosmos-reason2-8b',
      'moonshotai/kimi-k2.6',
      'z-ai/glm-5.3-flash',
      'minimaxai/minimax-m3.1-flash',
      'stepfun-ai/step-5-preview',
      'meta/llama-3.2-90b-vision-instruct',
      'meta/codellama-70b',
      'meta/llama2-70b',
      'meta/muse-glimmer-30b',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'nvidia/llama-3.1-nemotron-51b-instruct',
      'nvidia/llama-3.1-nemotron-ultra-253b-v1',
      'nvidia/llama3-chatqa-1.5-70b',
      'mistralai/mistral-large-4-1t-a52b',
      'mistralai/mistral-large-2-instruct',
      'mistralai/mistral-large',
      'mistralai/codestral-22b-instruct-v0.1',
      'mistralai/mixtral-8x22b-v0.1',
      'mistralai/mistral-7b-instruct-v0.3',
      'nv-mistralai/mistral-nemo-12b-instruct',
      'nvidia/mistral-nemo-minitron-8b-8k-instruct',
      'google/gemma-4-31b-it',
      'google/gemma-3-12b-it',
      'google/gemma-3-4b-it',
      'google/diffusiongemma-26b-a4b-it',
      'google/codegemma-1.1-7b',
      'google/codegemma-7b',
      'google/gemma-2b',
      'google/recurrentgemma-2b',
      'google/deplot',
      'microsoft/phi-3-vision-128k-instruct',
      'microsoft/phi-3.5-moe-instruct',
      'microsoft/kosmos-2',
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/nemotron-nano-3-30b-a3b',
      'nvidia/nemotron-4-340b-instruct',
      'nvidia/neva-22b',
      'nvidia/vila',
      'adept/fuyu-8b',
      'ibm/granite-3.0-8b-instruct',
      'ibm/granite-3.0-3b-a800m-instruct',
      'ibm/granite-34b-code-instruct',
      'ibm/granite-8b-code-instruct',
      'nvidia/riva-translate-4b-instruct',
      'nvidia/riva-translate-4b-instruct-v2',
      'openai/gpt-oss-20b',
      '01-ai/yi-large',
      'ai21labs/jamba-1.5-large-instruct',
      'aisingapore/sea-lion-7b-instruct',
      'bigcode/starcoder2-15b',
      'databricks/dbrx-instruct',
      'writer/palmyra-creative-122b',
      'writer/palmyra-fin-70b-32k',
      'writer/palmyra-med-70b',
      'writer/palmyra-med-70b-32k',
      'zyphra/zamba2-7b-instruct',
    ],
    defaultModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
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
  'cline-gui': {
    baseUrl: 'https://api.cline.bot/api/v1',
    models: [
      'nvidia/nemotron-3.5-lightning-free',
      'deepseek/deepseek-v4-flash',
      'kwaipilot/kat-coder-pro',
      'inclusionai/ling-3.2-flash:free',
      'google/gemini-4-hydrogen',
    ],
    defaultModel: 'nvidia/nemotron-3.5-lightning-free',
  },
  'cline-cli': {
    baseUrl: 'https://api.cline.bot/api/v1',
    models: [
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3.5-lightning-free',
      'deepseek/deepseek-v4-flash',
      'google/gemini-4-hydrogen',
      'inclusionai/ling-3.2-flash:free',
      'kwaipilot/kat-coder-pro',
    ],
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  },
  kilo: {
    baseUrl: 'https://ai-gateway.kilo.ai/api/v1',
    models: [
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'baidu/ernie-5.5-flash-preview:free',
      'dots-studio/dots-3-note-preview:free',
      'nvidia/nemotron-3.5-lightning:free',
      'minimax/minimax-m3.1-flash:free',
      'openrouter/free',
      'recursive/flint-v1.0:free',
      'nvidia/nemotron-3.5-super-vl:free',
      'qwen/qwen3.8-27b:free',
    ],
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
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
    providers[name] = {
      baseUrl: def.baseUrl,
      models: def.models,
      ...(def.defaultModel ? { defaultModel: def.defaultModel } : {}),
    };
  }
  return {
    defaultProvider: 'openrouter',
    providers,
    websearch: {
      provider: 'auto',
      exaApiKey: '',
      firecrawlApiKey: '',
      parallelApiKey: '',
      tavilyApiKey: '',
      tinyfishApiKey: '',
      braveApiKey: '',
      serperApiKey: '',
      extractProvider: 'auto',
    },
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
  // Strict read: a corrupt/unreadable auth.json throws instead of being
  // silently replaced by a blank file (which would wipe every stored key).
  const authFile = readAfotAuthFileStrict() ?? generateBlankAuthFile();
  authFile[providerName] = { type: 'api', key };
  atomicWriteFile(authPath, JSON.stringify(authFile, null, 2) + '\n', 0o600);
  debugLogger.log(`AFOT: Key saved for provider "${providerName}"`);
}

/**
 * Sets the default provider in ~/.afot/config.json at runtime.
 * Used by the `/provider` slash command.
 */
export function setAfotDefaultProvider(providerName: string): void {
  ensureAfotDir();
  const configPath = getAfotConfigFilePath();
  const config = readAfotConfigStrict() ?? generateDefaultConfigFile();
  config.defaultProvider = providerName;
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + '\n', 0o600);
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
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    debugLogger.log(`AFOT: Created default config.json at ${configPath}`);
  }
}

/**
 * Sets the default model for a specific provider in ~/.afot/config.json.
 */
export function setAfotProviderDefaultModel(
  providerName: string,
  modelId: string,
): void {
  ensureAfotDir();
  const configPath = getAfotConfigFilePath();
  const config = readAfotConfigStrict() ?? generateDefaultConfigFile();
  if (!config.providers) {
    config.providers = {};
  }
  if (!config.providers[providerName]) {
    config.providers[providerName] = { baseUrl: '' };
  }
  config.providers[providerName].defaultModel = modelId;
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + '\n', 0o600);
  debugLogger.log(
    `AFOT: Default model for provider "${providerName}" set to "${modelId}"`,
  );
}

// ─── In-memory Runtime Permissions State ───────────────────────────────────────

let _runtimeAutoApprove: boolean | undefined;
let _runtimeAutoApproveShell: boolean | undefined;
let _runtimeAutoApproveWorkspaceWrites: boolean | undefined;
let _runtimeAllowAllPaths: boolean | undefined;
let _runtimeShellApproval: AfotShellApprovalMode | undefined;

export function setAfotRuntimePermissions(
  perms: Partial<AfotPermissionsConfig>,
): void {
  if (perms.autoApprove !== undefined) _runtimeAutoApprove = perms.autoApprove;
  if (perms.autoApproveShell !== undefined)
    _runtimeAutoApproveShell = perms.autoApproveShell;
  if (perms.autoApproveWorkspaceWrites !== undefined)
    _runtimeAutoApproveWorkspaceWrites = perms.autoApproveWorkspaceWrites;
  if (perms.allowAllPaths !== undefined)
    _runtimeAllowAllPaths = perms.allowAllPaths;
  if (perms.shellApproval !== undefined)
    _runtimeShellApproval = perms.shellApproval;
}

export function resetAfotRuntimePermissions(): void {
  _runtimeAutoApprove = undefined;
  _runtimeAutoApproveShell = undefined;
  _runtimeAutoApproveWorkspaceWrites = undefined;
  _runtimeAllowAllPaths = undefined;
  _runtimeShellApproval = undefined;
}

/**
 * Checks whether global auto-approval is enabled in environment or ~/.afot/config.json.
 */
export function isAfotAutoApproveEnabled(
  config: AfotConfig | null = readAfotConfig(),
): boolean {
  if (_runtimeAutoApprove !== undefined) return _runtimeAutoApprove;
  const env = envFlag('AFOT_AUTO_APPROVE');
  if (env !== undefined) return env;
  const envMode = process.env['AFOT_APPROVAL_MODE']?.trim().toLowerCase();
  if (envMode === 'yolo') return true;
  return (
    config?.autoApprove === true ||
    config?.permissions?.autoApprove === true ||
    config?.approvalMode?.toLowerCase() === 'yolo'
  );
}

/**
 * Checks whether shell execution auto-approval is enabled.
 */
export function isAfotAutoApproveShellEnabled(
  config: AfotConfig | null = readAfotConfig(),
): boolean {
  if (isAfotAutoApproveEnabled(config)) return true;
  if (_runtimeAutoApproveShell !== undefined) return _runtimeAutoApproveShell;
  const env = envFlag('AFOT_AUTO_APPROVE_SHELL');
  if (env !== undefined) return env;
  return (
    config?.autoApproveShell === true ||
    config?.permissions?.autoApproveShell === true
  );
}

/**
 * Checks whether unrestricted filesystem directory access is enabled.
 */
export function isAfotAllowAllPathsEnabled(
  config: AfotConfig | null = readAfotConfig(),
): boolean {
  if (isAfotAutoApproveEnabled(config)) return true;
  if (_runtimeAllowAllPaths !== undefined) return _runtimeAllowAllPaths;
  const envAllowAll = envFlag('AFOT_ALLOW_ALL_PATHS');
  if (envAllowAll !== undefined) return envAllowAll;
  const guardEnv = process.env['AFOT_PATH_GUARD']?.trim().toLowerCase();
  if (
    guardEnv === 'off' ||
    guardEnv === '0' ||
    guardEnv === 'false' ||
    guardEnv === 'no' ||
    guardEnv === 'disabled'
  ) {
    return true;
  }
  return (
    config?.allowAllPaths === true ||
    config?.permissions?.allowAllPaths === true
  );
}

/**
 * Checks whether workspace write/edit auto-approval is enabled.
 */
export function isAfotAutoApproveWorkspaceWritesEnabled(
  config: AfotConfig | null = readAfotConfig(),
): boolean {
  if (isAfotAutoApproveEnabled(config)) return true;
  if (_runtimeAutoApproveWorkspaceWrites !== undefined)
    return _runtimeAutoApproveWorkspaceWrites;
  const env =
    envFlag('AFOT_AUTO_APPROVE_WRITES') ??
    envFlag('AFOT_AUTO_APPROVE_WORKSPACE_WRITES');
  if (env !== undefined) return env;
  return (
    config?.autoApproveWorkspaceWrites === true ||
    config?.permissions?.autoApproveWorkspaceWrites === true
  );
}

function parseShellApproval(v: unknown): AfotShellApprovalMode | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase();
  return t === 'workspace' || t === 'ask' ? t : undefined;
}

/**
 * Returns the shell approval mode. Precedence: runtime (slash command) >
 * AFOT_SHELL_APPROVAL env > config.json. Defaults to 'ask'.
 */
export function getAfotShellApprovalMode(
  config: AfotConfig | null = readAfotConfig(),
): AfotShellApprovalMode {
  if (_runtimeShellApproval !== undefined) return _runtimeShellApproval;
  const env = parseShellApproval(process.env['AFOT_SHELL_APPROVAL']);
  if (env) return env;
  return (
    parseShellApproval(config?.permissions?.shellApproval) ??
    parseShellApproval(config?.shellApproval) ??
    'ask'
  );
}

/**
 * True (default) when tool/shell output is rendered in full.
 * Precedence: env AFOT_FULL_OUTPUT (1/0) > config.fullOutput > true.
 */
export function isAfotFullOutputEnabled(
  config: AfotConfig | null = readAfotConfig(),
): boolean {
  const env = envFlag('AFOT_FULL_OUTPUT');
  if (env !== undefined) return env;
  return config?.fullOutput ?? true;
}

export type AfotMonitorMode = 'off' | 'compact' | 'expanded';
let _runtimeMonitor: AfotMonitorMode | undefined;

export function setAfotMonitorRuntime(mode: AfotMonitorMode | undefined): void {
  _runtimeMonitor = mode;
}

/** Sets the monitor mode for this session and persists it to config.json. */
export function setAfotMonitorMode(mode: AfotMonitorMode): void {
  _runtimeMonitor = mode;
  ensureAfotDir();
  const config = readAfotConfigStrict() ?? generateDefaultConfigFile();
  config.monitor = mode;
  atomicWriteFile(
    getAfotConfigFilePath(),
    JSON.stringify(config, null, 2) + '\n',
    0o600,
  );
}

/** Precedence: runtime > env AFOT_MONITOR > config.monitor > "off". */
export function getAfotMonitorMode(
  config: AfotConfig | null = readAfotConfig(),
): AfotMonitorMode {
  const ok = (v: unknown): v is AfotMonitorMode =>
    v === 'off' || v === 'compact' || v === 'expanded';
  if (_runtimeMonitor !== undefined) return _runtimeMonitor;
  const env = process.env['AFOT_MONITOR']?.trim().toLowerCase();
  if (ok(env)) return env;
  return ok(config?.monitor) ? config.monitor : 'off';
}

/** True when shell commands that stay inside the workspace skip the prompt. */
export function isAfotWorkspaceShellEnabled(
  config: AfotConfig | null = readAfotConfig(),
): boolean {
  return getAfotShellApprovalMode(config) === 'workspace';
}

/**
 * Retrieves configured extra allowed paths.
 */
export function getAfotAllowedPaths(
  config: AfotConfig | null = readAfotConfig(),
): string[] {
  const envPaths = process.env['AFOT_ALLOWED_PATHS']
    ?.split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const cfgPaths =
    config?.allowedPaths ?? config?.permissions?.allowedPaths ?? [];
  return [...new Set([...(envPaths ?? []), ...cfgPaths])];
}

/**
 * Retrieves configured default approval mode if set in env or config.
 */
export function getAfotApprovalMode(
  config: AfotConfig | null = readAfotConfig(),
): string | undefined {
  const envMode = process.env['AFOT_APPROVAL_MODE']?.trim();
  if (envMode) return envMode;
  if (isAfotAutoApproveEnabled(config)) return 'yolo';
  return config?.approvalMode;
}

/**
 * Persists the default approval mode to ~/.afot/config.json.
 */
export function setAfotApprovalMode(mode: string): void {
  ensureAfotDir();
  const configPath = getAfotConfigFilePath();
  const config = readAfotConfigStrict() ?? generateDefaultConfigFile();
  config.approvalMode = mode;
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + '\n', 0o600);
  debugLogger.log(`AFOT: Default approval mode set to "${mode}"`);
}

/**
 * Persists updated permissions settings to ~/.afot/config.json.
 */
export function setAfotPermissions(
  permissions: Partial<AfotPermissionsConfig>,
): void {
  ensureAfotDir();
  const configPath = getAfotConfigFilePath();
  const config = readAfotConfigStrict() ?? generateDefaultConfigFile();
  if (!config.permissions) {
    config.permissions = {};
  }
  Object.assign(config.permissions, permissions);
  if (permissions.autoApprove !== undefined) {
    config.autoApprove = permissions.autoApprove;
  }
  if (permissions.autoApproveShell !== undefined) {
    config.autoApproveShell = permissions.autoApproveShell;
  }
  if (permissions.allowAllPaths !== undefined) {
    config.allowAllPaths = permissions.allowAllPaths;
  }
  if (permissions.autoApproveWorkspaceWrites !== undefined) {
    config.autoApproveWorkspaceWrites = permissions.autoApproveWorkspaceWrites;
  }
  if (permissions.allowedPaths !== undefined) {
    config.allowedPaths = permissions.allowedPaths;
  }
  if (permissions.shellApproval !== undefined) {
    config.shellApproval = permissions.shellApproval;
  }
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + '\n', 0o600);
  debugLogger.log('AFOT: Permissions configuration updated');
}

export interface AfotRecentModel {
  id: string;
  provider: string;
}

export function getAfotRecentModels(): AfotRecentModel[] {
  const recentPath = path.join(getAfotDir(), 'recent_models.json');
  try {
    if (fs.existsSync(recentPath)) {
      const data = JSON.parse(fs.readFileSync(recentPath, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        return data;
      }
    }
  } catch {
    // fallback
  }
  return [];
}

export function saveAfotRecentModel(modelId: string, provider: string): void {
  ensureAfotDir();
  const recentPath = path.join(getAfotDir(), 'recent_models.json');
  const existing = getAfotRecentModels();
  const updated = [
    { id: modelId, provider },
    ...existing.filter((r) => !(r.id === modelId && r.provider === provider)),
  ].slice(0, 20);
  try {
    atomicWriteFile(recentPath, JSON.stringify(updated, null, 2) + '\n', 0o600);
  } catch (err) {
    debugLogger.warn(`AFOT: Failed to write recent_models.json: ${err}`);
  }
}

export function getAfotFavorites(): string[] {
  const favPath = path.join(getAfotDir(), 'favorites.json');
  try {
    if (fs.existsSync(favPath)) {
      const data = JSON.parse(fs.readFileSync(favPath, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch {
    // fallback
  }
  return [];
}

export function toggleAfotFavorite(modelId: string): boolean {
  ensureAfotDir();
  const favPath = path.join(getAfotDir(), 'favorites.json');
  const favs = new Set(getAfotFavorites());
  let isFavorite: boolean;
  if (favs.has(modelId)) {
    favs.delete(modelId);
    isFavorite = false;
  } else {
    favs.add(modelId);
    isFavorite = true;
  }
  try {
    atomicWriteFile(
      favPath,
      JSON.stringify(Array.from(favs), null, 2) + '\n',
      0o600,
    );
  } catch (err) {
    debugLogger.warn(`AFOT: Failed to write favorites.json: ${err}`);
  }
  return isFavorite;
}

/**
 * Returns the effective web search & extraction config, merging ~/.afot/config.json
 * with any active environment variables (e.g. EXA_API_KEY, FIRECRAWL_API_KEY, TAVILY_API_KEY).
 */
export function getAfotWebSearchConfig(): NonNullable<AfotConfig['websearch']> {
  const config = readAfotConfig();
  const ws = config?.websearch ?? {};

  const exaApiKey = (process.env['EXA_API_KEY'] || ws.exaApiKey || '').trim();
  const firecrawlApiKey = (
    process.env['FIRECRAWL_API_KEY'] ||
    ws.firecrawlApiKey ||
    ''
  ).trim();
  const parallelApiKey = (
    process.env['PARALLEL_API_KEY'] ||
    ws.parallelApiKey ||
    ''
  ).trim();
  const tavilyApiKey = (
    process.env['TAVILY_API_KEY'] ||
    ws.tavilyApiKey ||
    ''
  ).trim();
  const tinyfishApiKey = (
    process.env['TINYFISH_API_KEY'] ||
    ws.tinyfishApiKey ||
    ''
  ).trim();
  const braveApiKey = (
    process.env['BRAVE_API_KEY'] ||
    ws.braveApiKey ||
    ''
  ).trim();
  const serperApiKey = (
    process.env['SERPER_API_KEY'] ||
    ws.serperApiKey ||
    ''
  ).trim();

  // Explicit provider override or configured provider or 'auto'
  const envProvider = process.env[
    'AFOT_WEBSEARCH_PROVIDER'
  ]?.trim() as NonNullable<AfotConfig['websearch']>['provider'];
  const provider = envProvider || ws.provider || 'auto';

  const envExtract = process.env[
    'AFOT_WEBEXTRACT_PROVIDER'
  ]?.trim() as NonNullable<AfotConfig['websearch']>['extractProvider'];
  const extractProvider = envExtract || ws.extractProvider || 'auto';

  return {
    provider,
    exaApiKey,
    firecrawlApiKey,
    parallelApiKey,
    tavilyApiKey,
    tinyfishApiKey,
    braveApiKey,
    serperApiKey,
    extractProvider,
  };
}
