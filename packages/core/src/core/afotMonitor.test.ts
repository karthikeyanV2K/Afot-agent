/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getMonitorRequests,
  recordMonitorPoll,
  recordMonitorRequest,
  resetMonitor,
  subscribeMonitor,
  updateMonitorRequest,
} from './afotMonitor.js';
import {
  getAfotMonitorMode,
  setAfotMonitorRuntime,
} from './afotAuthStorage.js';

describe('afotMonitor store', () => {
  beforeEach(() => resetMonitor());

  it('records, updates and returns newest first', () => {
    const a = recordMonitorRequest({
      type: 'llm',
      target: 'm',
      status: 'sent',
    });
    recordMonitorRequest({ type: 'tool', target: 'shell', status: 'ok' });
    updateMonitorRequest(a, { status: 'ok', ms: 5, tokensIn: 9, tokensOut: 3 });
    const rows = getMonitorRequests();
    expect(rows.map((r) => r.target)).toEqual(['shell', 'm']);
    expect(rows[1]).toMatchObject({ status: 'ok', ms: 5, tokensIn: 9 });
  });

  it('caps the buffer at 50', () => {
    for (let i = 0; i < 80; i++) {
      recordMonitorRequest({ type: 'tool', target: String(i), status: 'ok' });
    }
    expect(getMonitorRequests(100)).toHaveLength(50);
    expect(getMonitorRequests(1)[0].target).toBe('79');
  });

  it('logs a poll only when status changes', () => {
    recordMonitorPoll('pid 1', 'running');
    recordMonitorPoll('pid 1', 'running');
    recordMonitorPoll('pid 1', 'exited');
    expect(getMonitorRequests()).toHaveLength(2);
  });

  it('notifies subscribers and survives a throwing listener', () => {
    const ok = vi.fn();
    const off1 = subscribeMonitor(() => {
      throw new Error('boom');
    });
    const off2 = subscribeMonitor(ok);
    recordMonitorRequest({ type: 'llm', target: 'm', status: 'sent' });
    expect(ok).toHaveBeenCalled();
    off1();
    off2();
  });
});

describe('getAfotMonitorMode', () => {
  afterEach(() => {
    setAfotMonitorRuntime(undefined);
    delete process.env['AFOT_MONITOR'];
  });
  it('defaults off; env, config and runtime layer in order', () => {
    expect(getAfotMonitorMode({})).toBe('off');
    expect(getAfotMonitorMode({ monitor: 'compact' })).toBe('compact');
    process.env['AFOT_MONITOR'] = 'expanded';
    expect(getAfotMonitorMode({ monitor: 'compact' })).toBe('expanded');
    setAfotMonitorRuntime('off');
    expect(getAfotMonitorMode({ monitor: 'compact' })).toBe('off');
    setAfotMonitorRuntime(undefined);
    process.env['AFOT_MONITOR'] = 'bogus';
    expect(getAfotMonitorMode({ monitor: 'bogus' })).toBe('off');
  });
});
