/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from './types.js';

const setMode = vi.fn();
const setRuntime = vi.fn();
vi.mock('@google/gemini-cli-core', () => ({
  getAfotMonitorMode: () => 'off',
  setAfotMonitorMode: (m: string) => setMode(m),
  setAfotMonitorRuntime: (m: string) => setRuntime(m),
}));

import { monitorCommand } from './monitorCommand.js';

const run = (args: string) =>
  monitorCommand.action!({} as CommandContext, args);

describe('/monitor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows status with no args', async () => {
    expect(await run('')).toMatchObject({ messageType: 'info' });
  });
  it('sets and persists a valid mode', async () => {
    expect(await run('expanded')).toMatchObject({ messageType: 'info' });
    expect(setMode).toHaveBeenCalledWith('expanded');
  });
  it('rejects invalid modes', async () => {
    expect(await run('loud')).toMatchObject({ messageType: 'error' });
    expect(setMode).not.toHaveBeenCalled();
  });
  it('falls back to session-only when persisting fails', async () => {
    setMode.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    const r = await run('compact');
    expect(setRuntime).toHaveBeenCalledWith('compact');
    expect(r).toMatchObject({ messageType: 'info' });
  });
});
