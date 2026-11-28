/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  getLatestTodos,
  windowTodos,
  type MonitorTodo,
} from './monitorTodos.js';
import { planMonitorLayout } from './monitorLayout.js';

const group = (todos: MonitorTodo[]) =>
  ({
    type: 'tool_group',
    tools: [{ resultDisplay: { todos } }, { resultDisplay: 'x' }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('getLatestTodos', () => {
  it('returns [] when no write_todos result exists', () => {
    expect(getLatestTodos([], [])).toEqual([]);
  });
  it('prefers pending (live) over history, newest first', () => {
    const old = [{ description: 'old', status: 'completed' as const }];
    const live = [{ description: 'live', status: 'in_progress' as const }];
    expect(getLatestTodos([group(old)], [group(live)])).toEqual(live);
    expect(getLatestTodos([group(old)], [])).toEqual(old);
  });
});

describe('windowTodos', () => {
  const t = (n: number): MonitorTodo[] =>
    Array.from({ length: n }, (_, i) => ({
      description: `t${i}`,
      status: i < 5 ? 'completed' : i === 5 ? 'in_progress' : 'pending',
    }));
  it('keeps the active task visible', () => {
    const w = windowTodos(t(12), 4);
    expect(w.shown).toHaveLength(4);
    expect(w.shown.some((x) => x.status === 'in_progress')).toBe(true);
    expect(w.hidden).toBe(8);
  });
});

describe('layout with todos', () => {
  it('gives todos priority and never exceeds budget', () => {
    for (let h = 1; h <= 90; h++) {
      const l = planMonitorLayout({
        terminalHeight: h,
        todos: 20,
        steps: 20,
        runners: 1,
        runnerLines: 5,
        requests: 30,
      });
      expect(l.rows).toBeLessThanOrEqual(Math.max(l.budget, 2));
      if (l.view === 'expanded') expect(l.todos).toBeGreaterThan(0);
    }
  });
});
