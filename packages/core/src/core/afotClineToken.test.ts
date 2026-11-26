/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ensureFreshClineToken,
  resetClineRefreshThrottle,
  type ClineDiscoveredAccount,
} from './afotClineBridge.js';
import { isAfotFullOutputEnabled } from './afotAuthStorage.js';

const acct = (o: Partial<ClineDiscoveredAccount>): ClineDiscoveredAccount =>
  ({
    id: 'cline-cli',
    alias: 'cli',
    token: 'new',
    refreshToken: 'rt',
    expiresAt: 0,
    isExpired: false,
    ...o,
  }) as ClineDiscoveredAccount;

describe('ensureFreshClineToken', () => {
  beforeEach(() => resetClineRefreshThrottle());

  it('picks up a token rotated on disk', async () => {
    const r = await ensureFreshClineToken('cline-cli', 'old', {
      discover: () => [acct({ token: 'new' })],
    });
    expect(r).toEqual({ token: 'new', changed: true });
  });

  it('reports unchanged when identical', async () => {
    const r = await ensureFreshClineToken('cline-cli', 'new', {
      discover: () => [acct({})],
    });
    expect(r.changed).toBe(false);
  });

  it('refreshes an expired token once per minute', async () => {
    const refresh = vi.fn().mockResolvedValue({
      success: true,
      message: 'ok',
      account: acct({ token: 'fresh' }),
    });
    const deps = {
      discover: () => [acct({ token: 'stale', expiresAt: 1000 })],
      refresh,
      now: () => 10_000_000,
    };
    const a = await ensureFreshClineToken('cline-cli', 'stale', deps);
    expect(a).toEqual({ token: 'fresh', changed: true });
    await ensureFreshClineToken('cline-cli', 'fresh', deps);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the current key when refresh fails or discovery throws', async () => {
    const r1 = await ensureFreshClineToken('cline-cli', 'k', {
      discover: () => [acct({ token: 'stale', expiresAt: 1000 })],
      refresh: vi.fn().mockResolvedValue({ success: false, message: 'no' }),
      now: () => 10_000_000,
    });
    expect(r1.token).toBe('stale');
    const r2 = await ensureFreshClineToken('cline-cli', 'k', {
      discover: () => {
        throw new Error('x');
      },
    });
    expect(r2).toEqual({ token: 'k', changed: false });
  });

  it('ignores unknown accounts', async () => {
    const r = await ensureFreshClineToken('cline-gui', 'k', {
      discover: () => [acct({})],
    });
    expect(r).toEqual({ token: 'k', changed: false });
  });
});

describe('isAfotFullOutputEnabled', () => {
  const prev = process.env['AFOT_FULL_OUTPUT'];
  afterEach(() => {
    if (prev === undefined) delete process.env['AFOT_FULL_OUTPUT'];
    else process.env['AFOT_FULL_OUTPUT'] = prev;
  });
  it('defaults on; env and config override', () => {
    delete process.env['AFOT_FULL_OUTPUT'];
    expect(isAfotFullOutputEnabled({})).toBe(true);
    expect(isAfotFullOutputEnabled({ fullOutput: false })).toBe(false);
    process.env['AFOT_FULL_OUTPUT'] = '0';
    expect(isAfotFullOutputEnabled({ fullOutput: true })).toBe(false);
    process.env['AFOT_FULL_OUTPUT'] = '1';
    expect(isAfotFullOutputEnabled({ fullOutput: false })).toBe(true);
  });
});
