/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverClineAccounts,
  refreshClineAccountToken,
} from './afotClineBridge.js';

vi.mock('../utils/debugLogger.js', () => ({
  debugLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('afotClineBridge', () => {
  let home: string;
  let providersPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'afot-cline-test-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('AFOT_HOME', path.join(home, '.afot'));
    const dir = path.join(home, '.cline-account-b', 'data', 'settings');
    fs.mkdirSync(dir, { recursive: true });
    providersPath = path.join(dir, 'providers.json');
    fs.writeFileSync(
      providersPath,
      JSON.stringify({
        providers: {
          cline: {
            settings: {
              model: 'deepseek/deepseek-v4-flash',
              auth: {
                accessToken: 'tok-old-123456789',
                refreshToken: 'ref-old',
                expiresAt: 1,
              },
            },
          },
        },
      }),
      { mode: 0o640 },
    );
    fs.chmodSync(providersPath, 0o640);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('never invents an identity: missing account info is reported as unknown', () => {
    const [acct] = discoverClineAccounts();
    expect(acct?.id).toBe('cline-cli');
    expect(acct?.email).toBe('(unknown)');
    expect(acct?.displayName).toBe('');
  });

  it('writes refreshed tokens back atomically without loosening file mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          access: 'tok-new-987654321',
          refresh: 'ref-new',
          expires: 9_999_999_999_999,
        }),
      }),
    );
    const res = await refreshClineAccountToken('b');
    expect(res.success).toBe(true);
    const saved = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
    expect(saved.providers.cline.settings.auth.accessToken).toBe(
      'tok-new-987654321',
    );
    expect(fs.statSync(providersPath).mode & 0o777).toBe(0o640);
    expect(
      fs
        .readdirSync(path.dirname(providersPath))
        .filter((f) => f.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('bounds the refresh request with a timeout signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'invalid' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await refreshClineAccountToken('cli');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
