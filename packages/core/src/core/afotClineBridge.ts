/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AFOT Cline & Kilo Code Bridge
 *
 * Discovers and bridges local Cline (VS Code GUI & Account B CLI)
 * and Kilo Code credentials and model configurations into AFOT CLI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  setAfotDefaultProvider,
  setAfotProviderKey,
  setAfotProviderDefaultModel,
  setAfotProviderModels,
  readAfotConfig,
  readAfotConfigStrict,
  getAfotConfigFilePath,
  ensureAfotDir,
  atomicWriteFile,
} from './afotAuthStorage.js';
import { debugLogger } from '../utils/debugLogger.js';

export interface ClineDiscoveredAccount {
  id: string; // 'cline-gui', 'cline-cli', 'kilo'
  alias: string; // 'gui', 'cli', 'b', 'kilo'
  name: string;
  email: string;
  userId?: string;
  displayName?: string;
  token: string;
  tokenMasked: string;
  refreshToken?: string;
  expiresAt: number;
  isExpired: boolean;
  activeModel: string;
  baseUrl: string;
  configPath: string;
  models: string[];
}

export const CLINE_API_BASE_URL = 'https://api.cline.bot/api/v1';
export const KILO_API_BASE_URL = 'https://ai-gateway.kilo.ai/api/v1';

const DEFAULT_CLINE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-lightning-free',
  'deepseek/deepseek-v4-flash',
  'google/gemini-4-hydrogen',
  'inclusionai/ling-3.2-flash:free',
  'kwaipilot/kat-coder-pro',
];

const DEFAULT_KILO_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'baidu/ernie-5.5-flash-preview:free',
  'dots-studio/dots-3-note-preview:free',
  'nvidia/nemotron-3.5-lightning:free',
  'minimax/minimax-m3.1-flash:free',
  'openrouter/free',
  'recursive/flint-v1.0:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'qwen/qwen3.8-27b:free',
];

function maskToken(t: string): string {
  if (!t || typeof t !== 'string') return '(none)';
  if (t.length <= 10) return '***';
  return t.slice(0, 8) + '...' + t.slice(-4);
}

/**
 * Discovers all local Cline accounts (Account A GUI, Account B CLI) and Kilo Code.
 */
export function discoverClineAccounts(): ClineDiscoveredAccount[] {
  const home = os.homedir();
  const accounts: ClineDiscoveredAccount[] = [];

  // ─── 1. Account 1: Primary Cline GUI (VS Code) ───────────────────────────
  const primarySecretsPath = path.join(home, '.cline', 'data', 'secrets.json');
  const primaryGlobalPath = path.join(home, '.cline', 'data', 'globalState.json');
  if (fs.existsSync(primarySecretsPath)) {
    try {
      const secrets = JSON.parse(fs.readFileSync(primarySecretsPath, 'utf8'));
      const rawAccount = secrets['cline:clineAccountId'];
      const accountData = rawAccount ? JSON.parse(rawAccount) : {};
      let globalState: Record<string, unknown> = {};
      if (fs.existsSync(primaryGlobalPath)) {
        try {
          globalState = JSON.parse(fs.readFileSync(primaryGlobalPath, 'utf8'));
        } catch {}
      }

      const idToken = String(accountData.idToken || '');
      const refreshToken = String(accountData.refreshToken || '');
      const rawExp = Number(accountData.expiresAt || 0);
      const expiresAt = rawExp > 0 ? (rawExp > 1e11 ? rawExp : rawExp * 1000) : 0;
      const isExpired = expiresAt > 0 && Date.now() > expiresAt;
      const defaultModel = String(
        globalState['actModeClineModelId'] ||
          globalState['planModeClineModelId'] ||
          'nvidia/nemotron-3.5-lightning-free',
      );

      accounts.push({
        id: 'cline-gui',
        alias: 'gui',
        name: 'Cline GUI (VS Code)',
        email: accountData.userInfo?.email || '(unknown)',
        userId: accountData.userInfo?.id || '',
        displayName: accountData.userInfo?.displayName || '',
        token: idToken,
        tokenMasked: maskToken(idToken),
        refreshToken: refreshToken,
        expiresAt: expiresAt,
        isExpired: isExpired,
        activeModel: defaultModel,
        baseUrl: CLINE_API_BASE_URL,
        configPath: path.join(home, '.cline'),
        models: [
          defaultModel,
          ...DEFAULT_CLINE_MODELS.filter((m) => m !== defaultModel),
        ],
      });
    } catch (e) {
      debugLogger.log(`Failed to read primary Cline account: ${e}`);
    }
  }

  // ─── 2. Account 2: Cline CLI (Account B) ─────────────────────────────────
  const bProvidersPath = path.join(
    home,
    '.cline-account-b',
    'data',
    'settings',
    'providers.json',
  );
  if (fs.existsSync(bProvidersPath)) {
    try {
      const bData = JSON.parse(fs.readFileSync(bProvidersPath, 'utf8'));
      const clineSettings = bData.providers?.cline?.settings || {};
      const auth = clineSettings.auth || {};
      const userInfo = auth.metadata?.userInfo || {};

      const accessToken = String(auth.accessToken || '');
      const refreshToken = String(auth.refreshToken || '');
      const expiresAt = Number(auth.expiresAt || 0);
      const isExpired = expiresAt > 0 && Date.now() > expiresAt;
      const defaultModel = String(
        clineSettings.model || 'nvidia/nemotron-3-ultra-550b-a55b:free',
      );

      accounts.push({
        id: 'cline-cli',
        alias: 'cli',
        name: 'Cline CLI (Account B)',
        email: userInfo.email || '(unknown)',
        userId: auth.accountId || userInfo.clineUserId || '',
        displayName: userInfo.name || '',
        token: accessToken,
        tokenMasked: maskToken(accessToken),
        refreshToken: refreshToken,
        expiresAt: expiresAt,
        isExpired: isExpired,
        activeModel: defaultModel,
        baseUrl: CLINE_API_BASE_URL,
        configPath: path.join(home, '.cline-account-b'),
        models: [
          defaultModel,
          ...DEFAULT_CLINE_MODELS.filter((m) => m !== defaultModel),
        ],
      });
    } catch (e) {
      debugLogger.log(`Failed to read Cline Account B: ${e}`);
    }
  }

  // ─── 3. Kilo Code (VS Code & AI Gateway) ──────────────────────────────────
  const kiloCachePath = path.join(home, '.cache', 'kilo', 'models.json');
  const kiloConfigPath = path.join(home, '.config', 'kilo');
  if (fs.existsSync(kiloConfigPath) || fs.existsSync(kiloCachePath)) {
    let customModels: string[] = [];
    if (fs.existsSync(kiloCachePath)) {
      try {
        const cache = JSON.parse(fs.readFileSync(kiloCachePath, 'utf8'));
        if (typeof cache === 'object' && cache !== null) {
          for (const prov of Object.values(cache) as Array<{ models?: Record<string, { id?: string }> }>) {
            if (prov?.models) {
              for (const mid of Object.keys(prov.models)) {
                if (customModels.length < 25) customModels.push(mid);
              }
            }
          }
        }
      } catch {}
    }

    const modelsList = customModels.length > 0 ? customModels : DEFAULT_KILO_MODELS;

    accounts.push({
      id: 'kilo',
      alias: 'kilo',
      name: 'Kilo Code AI Gateway',
      email: 'Local Kilo Code / VS Code',
      userId: 'kilo-local',
      displayName: 'Kilo Code Free Tier',
      token: 'kilo-direct',
      tokenMasked: '(local direct gateway)',
      refreshToken: '',
      expiresAt: 0,
      isExpired: false,
      activeModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      baseUrl: KILO_API_BASE_URL,
      configPath: kiloConfigPath,
      models: modelsList,
    });
  }

  return accounts;
}

/**
 * Gets currently active Cline account if AFOT is connected to one.
 */
export function getActiveClineAccount(): ClineDiscoveredAccount | null {
  const config = readAfotConfig();
  const defaultProv = config?.defaultProvider;
  if (!defaultProv) return null;

  const accounts = discoverClineAccounts();
  return accounts.find((a) => a.id === defaultProv || a.alias === defaultProv) ?? null;
}

/**
 * Refreshes OAuth token for a Cline account via Cline's refresh endpoint.
 */
export async function refreshClineAccountToken(
  targetIdOrAlias: string,
): Promise<{ success: boolean; message: string; account?: ClineDiscoveredAccount }> {
  const accounts = discoverClineAccounts();
  const target = accounts.find(
    (a) =>
      a.id.toLowerCase() === targetIdOrAlias.toLowerCase() ||
      a.alias.toLowerCase() === targetIdOrAlias.toLowerCase() ||
      (targetIdOrAlias.toLowerCase() === 'b' && a.id === 'cline-cli'),
  );

  if (!target) {
    return {
      success: false,
      message: `Account "${targetIdOrAlias}" not found. Available: gui, cli (or b), kilo`,
    };
  }

  if (!target.refreshToken) {
    return {
      success: false,
      message: `Account "${target.name}" has no refresh token stored. Re-authenticate via Cline CLI or VS Code.`,
    };
  }

  try {
    const res = await fetch(`${target.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: target.refreshToken,
        grantType: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = (await res.json().catch(() => null)) as {
      access?: string;
      refresh?: string;
      expires?: number;
      error?: string;
    } | null;

    if (!res.ok || !data?.access) {
      const errStr = data?.error || res.statusText;
      return {
        success: false,
        message: `Token refresh failed (${res.status}): ${errStr}. Please open Cline in VS Code or run 'cline auth' to renew the session.`,
      };
    }

    const newAccessToken = String(data.access);
    const newRefreshToken = String(data.refresh || target.refreshToken);
    const newExpiresAt = Number(data.expires || Date.now() + 14 * 24 * 3600 * 1000);

    // Save back to disk based on account type
    if (target.id === 'cline-cli') {
      const bProvidersPath = path.join(
        target.configPath,
        'data',
        'settings',
        'providers.json',
      );
      if (fs.existsSync(bProvidersPath)) {
        const bData = JSON.parse(fs.readFileSync(bProvidersPath, 'utf8'));
        if (bData.providers?.cline?.settings?.auth) {
          bData.providers.cline.settings.auth.accessToken = newAccessToken;
          bData.providers.cline.settings.auth.refreshToken = newRefreshToken;
          bData.providers.cline.settings.auth.expiresAt = newExpiresAt;
          atomicWriteFile(bProvidersPath, JSON.stringify(bData, null, 2));
        }
      }
    } else if (target.id === 'cline-gui') {
      const secretsPath = path.join(target.configPath, 'data', 'secrets.json');
      if (fs.existsSync(secretsPath)) {
        const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
        const accountData = secrets['cline:clineAccountId']
          ? JSON.parse(secrets['cline:clineAccountId'])
          : {};
        accountData.idToken = newAccessToken;
        accountData.refreshToken = newRefreshToken;
        accountData.expiresAt = Math.floor(newExpiresAt / 1000);
        secrets['cline:clineAccountId'] = JSON.stringify(accountData);
        atomicWriteFile(secretsPath, JSON.stringify(secrets, null, 2));
      }
    }

    // Also update AFOT's active key
    setAfotProviderKey(target.id, newAccessToken);

    const refreshed = discoverClineAccounts().find((a) => a.id === target.id);
    return {
      success: true,
      message: `✓ Successfully refreshed token for ${target.name} (${target.email})`,
      account: refreshed,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: `Failed to connect to Cline refresh endpoint: ${msg}`,
    };
  }
}

const lastRefreshAttempt = new Map<string, number>();

/**
 * Returns the freshest known token for a Cline provider ("cline-gui"/"cline-cli").
 * AFOT copies the token into auth.json once, so it goes stale when Cline itself
 * renews it or it expires. Re-read the source of truth, and refresh if expired
 * (at most once per minute per account). Never throws.
 */
export async function ensureFreshClineToken(
  providerId: string,
  currentKey: string,
  deps: {
    discover?: () => ClineDiscoveredAccount[];
    refresh?: typeof refreshClineAccountToken;
    now?: () => number;
  } = {},
): Promise<{ token: string; changed: boolean }> {
  const discover = deps.discover ?? discoverClineAccounts;
  const refresh = deps.refresh ?? refreshClineAccountToken;
  const now = (deps.now ?? Date.now)();
  try {
    let acct = discover().find((a) => a.id === providerId);
    if (!acct || !acct.token) return { token: currentKey, changed: false };
    const nearExpiry = acct.expiresAt > 0 && now > acct.expiresAt - 60_000;
    const last = lastRefreshAttempt.get(providerId) ?? 0;
    if (nearExpiry && acct.refreshToken && now - last > 60_000) {
      lastRefreshAttempt.set(providerId, now);
      const r = await refresh(providerId);
      if (r.success && r.account?.token) acct = r.account;
    }
    return { token: acct.token, changed: acct.token !== currentKey };
  } catch (e) {
    debugLogger.log(`ensureFreshClineToken failed: ${e}`);
    return { token: currentKey, changed: false };
  }
}

/** Clears the refresh throttle (tests). */
export function resetClineRefreshThrottle(): void {
  lastRefreshAttempt.clear();
}

/**
 * Activates a Cline or Kilo account as AFOT's active provider and configures its model.
 */
export async function activateClineAccount(
  targetIdOrAlias: string,
  modelOverride?: string,
): Promise<{ success: boolean; message: string; account?: ClineDiscoveredAccount }> {
  const accounts = discoverClineAccounts();
  const target = accounts.find(
    (a) =>
      a.id.toLowerCase() === targetIdOrAlias.toLowerCase() ||
      a.alias.toLowerCase() === targetIdOrAlias.toLowerCase() ||
      (targetIdOrAlias.toLowerCase() === 'b' && a.id === 'cline-cli'),
  );

  if (!target) {
    return {
      success: false,
      message: `Account "${targetIdOrAlias}" not found. Available: gui, cli (or b), kilo`,
    };
  }

  const selectedModel = modelOverride || target.activeModel;

  // 1. Write/update credentials in ~/.afot/auth.json
  setAfotProviderKey(target.id, target.token || 'kilo-direct');

  // 2. Write/update provider definition in ~/.afot/config.json
  ensureAfotDir();
  const config = readAfotConfigStrict() || {};
  if (!config.providers) config.providers = {};

  config.providers[target.id] = {
    baseUrl: target.baseUrl,
    models: target.models,
    defaultModel: selectedModel,
  };
  config.defaultProvider = target.id;
  config.defaultModel = selectedModel;

  const configPath = getAfotConfigFilePath();
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + '\n', 0o600);

  // 3. Mark as default provider & models
  setAfotDefaultProvider(target.id);
  setAfotProviderModels(target.id, target.models, selectedModel);
  setAfotProviderDefaultModel(target.id, selectedModel);

  return {
    success: true,
    message: `✓ Connected to ${target.name} (${target.email}) | Model: ${selectedModel}`,
    account: target,
  };
}

/**
 * Switches the active model directly for the Cline/Kilo connection.
 */
export function setClineModel(modelId: string): { success: boolean; message: string } {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return { success: false, message: 'Please specify a model ID.' };
  }

  const config = readAfotConfigStrict() || {};
  const currentProvider = config.defaultProvider || 'cline-cli';

  ensureAfotDir();
  if (!config.providers) config.providers = {};
  if (!config.providers[currentProvider]) {
    config.providers[currentProvider] = {
      baseUrl: CLINE_API_BASE_URL,
      models: [trimmed],
      defaultModel: trimmed,
    };
  } else {
    config.providers[currentProvider].defaultModel = trimmed;
    if (!config.providers[currentProvider].models?.includes(trimmed)) {
      config.providers[currentProvider].models?.unshift(trimmed);
    }
  }

  config.defaultModel = trimmed;
  const configPath = getAfotConfigFilePath();
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + '\n', 0o600);

  setAfotProviderDefaultModel(currentProvider, trimmed);

  return {
    success: true,
    message: `✓ Active model set to "${trimmed}" for ${currentProvider}`,
  };
}

/**
 * Fetches live models directly from Cline API if reachable.
 */
export async function fetchLiveClineModels(token?: string): Promise<string[]> {
  const accounts = discoverClineAccounts();
  const authToken = token || accounts.find((a) => a.token)?.token;
  if (!authToken) return DEFAULT_CLINE_MODELS;

  try {
    const res = await fetch(`${CLINE_API_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return DEFAULT_CLINE_MODELS;
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    if (Array.isArray(body?.data)) {
      return body.data.map((m) => m.id);
    }
  } catch {}
  return DEFAULT_CLINE_MODELS;
}
