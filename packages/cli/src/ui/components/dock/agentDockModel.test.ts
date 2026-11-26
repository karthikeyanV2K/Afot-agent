/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_GLYPH,
  computeDockHeight,
  computePaneWindow,
  countAgentStates,
  dockBodyRows,
  formatAgentLine,
  formatElapsedShort,
  formatWindowFooter,
  mapSubagentState,
  mapSwarmMemberState,
  sortAgentRows,
  windowAgentRows,
  type AgentRow,
} from './agentDockModel.js';

const row = (
  name: string,
  state: AgentRow['state'],
  extra: Partial<AgentRow> = {},
): AgentRow => ({ key: name, name, state, ...extra });

describe('agentDockModel state mapping', () => {
  it('maps swarm member states', () => {
    expect(mapSwarmMemberState('working')).toBe('running');
    expect(mapSwarmMemberState('waiting')).toBe('waiting');
    expect(mapSwarmMemberState('stopped')).toBe('failed');
    expect(mapSwarmMemberState('killed')).toBe('failed');
    expect(mapSwarmMemberState('anything-else')).toBe('idle');
  });

  it('maps subagent states', () => {
    expect(mapSubagentState('running')).toBe('running');
    expect(mapSubagentState('completed')).toBe('done');
    expect(mapSubagentState('error')).toBe('failed');
    expect(mapSubagentState('cancelled')).toBe('failed');
    // Progress without a settled state is still running.
    expect(mapSubagentState(undefined)).toBe('running');
  });
});

describe('formatElapsedShort', () => {
  it('formats minutes and seconds', () => {
    expect(formatElapsedShort(0)).toBe('0:00');
    expect(formatElapsedShort(12_000)).toBe('0:12');
    expect(formatElapsedShort(61_000)).toBe('1:01');
    expect(formatElapsedShort(3_600_000)).toBe('60:00');
  });

  it('rejects invalid values', () => {
    expect(formatElapsedShort(-1)).toBe('');
    expect(formatElapsedShort(Number.NaN)).toBe('');
  });
});

describe('sortAgentRows', () => {
  it('puts running, waiting and failed rows above idle rows', () => {
    const sorted = sortAgentRows([
      row('idle-b', 'idle'),
      row('done', 'done'),
      row('failed', 'failed'),
      row('waiting', 'waiting'),
      row('running', 'running'),
      row('idle-a', 'idle'),
    ]);
    expect(sorted.map((r) => r.name)).toEqual([
      'running',
      'waiting',
      'failed',
      'done',
      'idle-a',
      'idle-b',
    ]);
  });

  it('does not mutate the input', () => {
    const rows = [row('b', 'idle'), row('a', 'idle')];
    sortAgentRows(rows);
    expect(rows.map((r) => r.name)).toEqual(['b', 'a']);
  });
});

describe('countAgentStates', () => {
  it('counts every state', () => {
    const counts = countAgentStates([
      row('a', 'running'),
      row('b', 'running'),
      row('c', 'waiting'),
      row('d', 'done'),
      row('e', 'failed'),
    ]);
    expect(counts).toEqual({
      running: 2,
      waiting: 1,
      idle: 0,
      done: 1,
      failed: 1,
    });
  });
});

describe('formatAgentLine', () => {
  it('includes glyph, name, state, elapsed and detail', () => {
    const line = formatAgentLine(
      row('researcher', 'running', {
        elapsedMs: 12_000,
        detail: 'web_search',
      }),
      80,
    );
    expect(line).toContain(`${AGENT_GLYPH.running} researcher`);
    expect(line).toContain('working');
    expect(line).toContain('0:12');
    expect(line).toContain('web_search');
  });

  it('keeps the line within the requested width', () => {
    const line = formatAgentLine(
      row('a-very-long-agent-name-here', 'running', {
        detail: 'x'.repeat(200),
      }),
      40,
    );
    expect(line.length).toBeLessThanOrEqual(40);
  });
});

describe('computeDockHeight', () => {
  it('sizes to content with a minimum', () => {
    expect(computeDockHeight(0, 40)).toBe(6);
    expect(computeDockHeight(3, 40)).toBe(6);
    expect(computeDockHeight(6, 40)).toBe(9);
  });

  it('caps at a third of the terminal', () => {
    expect(computeDockHeight(100, 40)).toBe(13);
  });

  it('uses a fixed block in inline mode', () => {
    expect(computeDockHeight(100, 40, { inline: true })).toBe(8);
    expect(computeDockHeight(0, 40, { inline: true })).toBe(6);
  });

  it('never exceeds the terminal', () => {
    expect(computeDockHeight(100, 10)).toBe(6);
    expect(computeDockHeight(100, 5)).toBe(1);
  });
});

describe('dockBodyRows', () => {
  it('subtracts the border and header', () => {
    expect(dockBodyRows(9)).toBe(6);
    expect(dockBodyRows(2)).toBe(0);
  });
});

describe('windowAgentRows', () => {
  it('returns everything when it fits', () => {
    const rows = [row('a', 'running'), row('b', 'idle')];
    expect(windowAgentRows(rows, 5)).toEqual({ visible: rows, hidden: 0 });
  });

  it('reports how many rows are hidden', () => {
    const rows = [row('a', 'running'), row('b', 'idle'), row('c', 'idle')];
    const result = windowAgentRows(rows, 2);
    expect(result.visible.map((r) => r.name)).toEqual(['a', 'b']);
    expect(result.hidden).toBe(1);
  });

  it('hides everything when there is no room', () => {
    const rows = [row('a', 'running')];
    expect(windowAgentRows(rows, 0)).toEqual({ visible: [], hidden: 1 });
  });
});

describe('computePaneWindow', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(`a${i}`, 'idle'));

  it('shows everything when it fits', () => {
    const window = computePaneWindow(rows, 10, 0);
    expect(window.visible).toHaveLength(6);
    expect(window.hiddenBefore).toBe(0);
    expect(window.hiddenAfter).toBe(0);
    expect(window.maxOffset).toBe(0);
  });

  it('reserves a row for the scroll indicator', () => {
    const window = computePaneWindow(rows, 4, 0);
    expect(window.visible).toHaveLength(3);
    expect(window.hiddenAfter).toBe(3);
    expect(window.maxOffset).toBe(3);
  });

  it('scrolls and clamps the offset', () => {
    const window = computePaneWindow(rows, 4, 2);
    expect(window.visible.map((r) => r.name)).toEqual(['a2', 'a3', 'a4']);
    expect(window.hiddenBefore).toBe(2);
    expect(window.hiddenAfter).toBe(1);

    const clamped = computePaneWindow(rows, 4, 99);
    expect(clamped.visible.map((r) => r.name)).toEqual(['a3', 'a4', 'a5']);
    expect(clamped.hiddenBefore).toBe(3);
    expect(clamped.hiddenAfter).toBe(0);
  });
});

describe('formatWindowFooter', () => {
  it('is null when everything is visible', () => {
    expect(
      formatWindowFooter(computePaneWindow([row('a', 'idle')], 5, 0)),
    ).toBe(null);
  });

  it('reports what is hidden above and below', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`a${i}`, 'idle'));
    const window = computePaneWindow(rows, 4, 2);
    expect(formatWindowFooter(window)).toBe('↑ 2 more · ↓ 1 more');
  });
});
