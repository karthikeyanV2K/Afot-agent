/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenCode Console OAuth Device Flow
 *
 * Implements the RFC 8628 device authorization grant used by OpenCode CLI
 * to authenticate against https://opencode.ai/console.
 *
 * Flow:
 *   1. POST /auth/device/code   → { device_code, user_code, verification_uri_complete, interval }
 *   2. Open browser to verification_uri_complete
 *   3. Poll POST /auth/device/token until access_token arrives
 *   4. Store { access_token, refresh_token, expires_at } in ~/.afot/auth.json
 *      under key "opencode" as type "oauth"
 *   5. GET /api/v2/config with Bearer <access_token> → provider base URL + models
 *   6. Use that base URL + Bearer as API key for AfotOpenAIContentGenerator
 *
 * References:
 *   packages/core/src/plugin/provider/opencode.ts  (clientID, endpoints, poll logic)
 *   packages/core/src/console-access.ts            (defaultServer, headers())
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { debugLogger } from '../utils/debugLogger.js';
import {
  getAfotDir,
  readAfotAuthFile,
} from './afotAuthStorage.js';

// ─── Constants (from OpenCode source) ────────────────────────────────────────

export const OPENCODE_CONSOLE_SERVER = 'https://opencode.ai/console';
export const OPENCODE_CLIENT_ID = 'opencode-cli';
export const OPENCODE_PROVIDER_KEY = 'opencode'; // key in auth.json

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpenCodeDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface OpenCodeTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  org_id?: string | null;
}

export interface OpenCodeOAuthCredential {
  type: 'oauth';
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  org_id?: string;
  server: string;
}

export interface OpenCodeConsoleConfig {
  baseUrl: string;
  models: string[];
  orgId?: string;
}

// ─── Auth file helpers ────────────────────────────────────────────────────────

export function getOpenCodeCredential(): OpenCodeOAuthCredential | null {
  const authFile = readAfotAuthFile();
  if (!authFile) return null;
  const entry = authFile[OPENCODE_PROVIDER_KEY];
  if (!entry || entry.type !== 'oauth') return null;
  return entry as unknown as OpenCodeOAuthCredential;
}

export function saveOpenCodeCredential(cred: OpenCodeOAuthCredential): void {
  const authPath = path.join(getAfotDir(), 'auth.json');
  let authFile = readAfotAuthFile() ?? {};
  authFile[OPENCODE_PROVIDER_KEY] = cred as unknown as import('./afotAuthStorage.js').AfotAuthEntry;
  fs.writeFileSync(authPath, JSON.stringify(authFile, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  debugLogger.log('AFOT: OpenCode Console credential saved');
}

export function clearOpenCodeCredential(): void {
  const authPath = path.join(getAfotDir(), 'auth.json');
  const authFile = readAfotAuthFile();
  if (!authFile) return;
  delete authFile[OPENCODE_PROVIDER_KEY];
  fs.writeFileSync(authPath, JSON.stringify(authFile, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  debugLogger.log('AFOT: OpenCode Console credential cleared');
}

export function isOpenCodeCredentialExpired(cred: OpenCodeOAuthCredential): boolean {
  // Refresh 5 minutes before actual expiry
  return Date.now() >= cred.expires_at - 5 * 60 * 1000;
}

// ─── Device flow ─────────────────────────────────────────────────────────────

/**
 * Step 1: Request a device code from OpenCode Console.
 * Returns the device code response with a fully-resolved verification URL.
 */
export async function requestDeviceCode(
  server: string = OPENCODE_CONSOLE_SERVER,
): Promise<OpenCodeDeviceCodeResponse> {
  const resp = await fetch(`${server}/auth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: OPENCODE_CLIENT_ID,
      supports_org_scope: true,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Device code request failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as OpenCodeDeviceCodeResponse;

  // The server returns a relative URL (e.g. "/console/device?user_code=...").
  // Resolve it against the server base exactly as OpenCode's own source does:
  //   new URL(device.verification_uri_complete, `${server}/`)
  const base = server.endsWith('/') ? server : `${server}/`;
  try {
    const resolved = new URL(data.verification_uri_complete, base);
    // Only accept http/https — guard against malformed responses
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      data.verification_uri_complete = resolved.href;
    }
  } catch {
    // If already absolute or unparseable, leave as-is
  }

  return data;
}

/**
 * Step 3: Poll for the access token.
 * Returns the token when granted, or null if still pending (authorization_pending / slow_down).
 * Throws on non-recoverable errors (expired, denied, etc.).
 */
export async function pollDeviceToken(
  deviceCode: string,
  server: string = OPENCODE_CONSOLE_SERVER,
): Promise<OpenCodeTokenResponse | null> {
  const resp = await fetch(`${server}/auth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: OPENCODE_CLIENT_ID,
    }),
  });

  const body = (await resp.json()) as { error?: string } & Partial<OpenCodeTokenResponse>;

  if (body.error) {
    if (
      body.error === 'authorization_pending' ||
      body.error === 'slow_down'
    ) {
      return null; // still waiting
    }
    throw new Error(`Device token error: ${body.error}`);
  }

  if (!body.access_token || !body.refresh_token) {
    throw new Error('Invalid token response from OpenCode Console');
  }

  return body as OpenCodeTokenResponse;
}

/**
 * Refresh an existing access token using the refresh token.
 * Returns null if the refresh token is invalid (user must re-login).
 */
export async function refreshOpenCodeToken(
  refreshToken: string,
  server: string = OPENCODE_CONSOLE_SERVER,
): Promise<OpenCodeTokenResponse | null> {
  const resp = await fetch(`${server}/auth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENCODE_CLIENT_ID,
    }),
  });

  if (resp.status === 400) {
    const body = (await resp.json()) as { error?: string };
    if (body.error === 'invalid_grant') {
      debugLogger.log('AFOT: OpenCode refresh token expired — need re-login');
      return null;
    }
  }

  if (!resp.ok) {
    throw new Error(`Token refresh failed (${resp.status})`);
  }

  return resp.json() as Promise<OpenCodeTokenResponse>;
}

/**
 * Fetch the console config which provides the inference base URL and available models.
 * Returns null if not authenticated or console unavailable.
 */
export async function fetchOpenCodeConsoleConfig(
  accessToken: string,
  orgId?: string,
  server: string = OPENCODE_CONSOLE_SERVER,
): Promise<OpenCodeConsoleConfig | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  if (orgId) headers['x-org-id'] = orgId;

  const resp = await fetch(`${server}/api/v2/config`, { headers });

  if (resp.status === 401 || resp.status === 404) return null;

  if (!resp.ok) {
    debugLogger.warn(`AFOT: OpenCode config fetch failed (${resp.status})`);
    return null;
  }

  const body = (await resp.json()) as {
    providers?: Record<string, {
      settings?: Record<string, string>;
      models?: Record<string, unknown>;
    }>;
  };

  // The OpenCode provider's base URL comes from its settings.baseURL
  // If not present, fall back to the console's AI proxy path
  const opencodeProv = body.providers?.['opencode'];
  const baseUrl =
    opencodeProv?.settings?.['baseURL'] ??
    `${server}/ai/v1`;

  const modelEntries = opencodeProv?.models
    ? Object.entries(opencodeProv.models)
    : [];
  const enabledModels = modelEntries
    .filter(([, meta]) => !(meta as { disabled?: boolean })?.disabled)
    .map(([id]) => id);
  const rawModels =
    enabledModels.length > 0 ? enabledModels : modelEntries.map(([id]) => id);

  // Prioritize free models first so free tier accounts work out of the box
  const freeModels = rawModels.filter((m) => m.endsWith('-free') || m.includes('-free'));
  const paidModels = rawModels.filter((m) => !m.endsWith('-free') && !m.includes('-free'));
  const models = [...freeModels, ...paidModels];

  return { baseUrl, models, orgId };
}

/**
 * Ensure the stored credential is valid, refreshing if needed.
 * Returns the valid access token, or null if re-login is required.
 */
export async function ensureValidOpenCodeToken(): Promise<{
  accessToken: string;
  credential: OpenCodeOAuthCredential;
} | null> {
  const cred = getOpenCodeCredential();
  if (!cred) return null;

  if (!isOpenCodeCredentialExpired(cred)) {
    return { accessToken: cred.access_token, credential: cred };
  }

  // Try to refresh
  try {
    const refreshed = await refreshOpenCodeToken(
      cred.refresh_token,
      cred.server ?? OPENCODE_CONSOLE_SERVER,
    );
    if (!refreshed) {
      clearOpenCodeCredential();
      return null;
    }

    const updated: OpenCodeOAuthCredential = {
      ...cred,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: Date.now() + refreshed.expires_in * 1000,
      org_id: refreshed.org_id ?? cred.org_id,
    };
    saveOpenCodeCredential(updated);
    return { accessToken: updated.access_token, credential: updated };
  } catch (err) {
    debugLogger.warn(`AFOT: Token refresh failed: ${err}`);
    return null;
  }
}

/**
 * Get the resolved OpenCode Console provider config for use with AfotOpenAIContentGenerator.
 * Returns null if not logged in.
 */
export async function resolveOpenCodeProvider(): Promise<{
  key: string;
  baseUrl: string;
  models: string[];
  name: string;
} | null> {
  const tokenResult = await ensureValidOpenCodeToken();
  if (!tokenResult) return null;

  const { accessToken, credential } = tokenResult;

  // Try to fetch config from console
  const consoleConfig = await fetchOpenCodeConsoleConfig(
    accessToken,
    credential.org_id,
    credential.server ?? OPENCODE_CONSOLE_SERVER,
  ).catch(() => null);

  const baseUrl = consoleConfig?.baseUrl ?? `${OPENCODE_CONSOLE_SERVER}/ai/v1`;
  const models = consoleConfig?.models ?? [];

  return {
    key: accessToken, // Bearer token used as "api key"
    baseUrl,
    models,
    name: 'opencode',
  };
}
