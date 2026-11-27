/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  MONITOR_MAX_ROWS,
  MONITOR_RESERVED_ROWS,
  monitorBudget,
  planMonitorLayout,
} from './monitorLayout.js';

const base = { steps: 0, runners: 0, runnerLines: 0, requests: 0 };

describe('monitorBudget', () => {
  it('reserves rows for the rest of the UI and caps the panel', () => {
    expect(monitorBudget(10)).toBe(0);
    expect(monitorBudget(MONITOR_RESERVED_ROWS)).toBe(0);
    expect(monitorBudget(28)).toBe(12);
    expect(monitorBudget(200)).toBe(MONITOR_MAX_ROWS);
  });
});

describe('planMonitorLayout', () => {
  it('hides on tiny terminals and degrades to 2 lines on short ones', () => {
    expect(
      planMonitorLayout({ ...base, terminalHeight: 15, steps: 3 }).view,
    ).toBe('hidden');
    const c = planMonitorLayout({ ...base, terminalHeight: 20, steps: 3 });
    expect(c.view).toBe('compact');
    expect(c.rows).toBe(2);
  });

  it('NEVER exceeds the budget, for any terminal height and data mix', () => {
    for (let h = 1; h <= 90; h++) {
      for (const steps of [0, 1, 3, 12, 80]) {
        for (const runners of [0, 1, 2]) {
          for (const requests of [0, 1, 6, 50]) {
            const l = planMonitorLayout({
              terminalHeight: h,
              steps,
              runners,
              runnerLines: runners ? 5 : 0,
              requests,
            });
            expect(
              l.rows,
              `h=${h} s=${steps} r=${runners} q=${requests}`,
            ).toBeLessThanOrEqual(
              Math.max(l.budget, l.view === 'compact' ? 2 : 0),
            );
            expect(l.rows).toBeLessThanOrEqual(MONITOR_MAX_ROWS);
          }
        }
      }
    }
  });

  it('keeps steps before runner before requests when space is tight', () => {
    const l = planMonitorLayout({
      terminalHeight: MONITOR_RESERVED_ROWS + 6,
      steps: 5,
      runners: 1,
      runnerLines: 3,
      requests: 5,
    });
    expect(l.view).toBe('expanded');
    expect(l.steps).toBeGreaterThan(0);
    expect(l.rows).toBeLessThanOrEqual(6);
  });

  it('uses spare rows when the terminal is tall', () => {
    const l = planMonitorLayout({
      terminalHeight: 60,
      steps: 10,
      runners: 1,
      runnerLines: 5,
      requests: 10,
    });
    expect(l.view).toBe('expanded');
    expect(l.steps).toBeGreaterThanOrEqual(4);
    expect(l.requests).toBeGreaterThanOrEqual(3);
    expect(l.rows).toBe(MONITOR_MAX_ROWS);
  });
});
