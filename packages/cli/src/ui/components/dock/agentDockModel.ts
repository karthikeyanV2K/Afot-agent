/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { clip } from '../../utils/monitorTimeline.js';

export type AgentRowState = 'running' | 'waiting' | 'idle' | 'done' | 'failed';

export interface AgentRow {
  key: string;
  name: string;
  role?: string;
  state: AgentRowState;
  detail?: string;
  elapsedMs?: number;
}

export type AgentStateCounts = Record<AgentRowState, number>;

export const AGENT_GLYPH: Record<AgentRowState, string> = {
  running: '◉',
  waiting: '◌',
  idle: '○',
  done: '●',
  failed: '✗',
};

export const AGENT_STATE_LABEL: Record<AgentRowState, string> = {
  running: 'working',
  waiting: 'waiting',
  idle: 'idle',
  done: 'done',
  failed: 'failed',
};

const STATE_PRIORITY: Record<AgentRowState, number> = {
  running: 0,
  waiting: 1,
  failed: 2,
  done: 3,
  idle: 4,
};

/** Map the swarm roster's member states onto the dock's row states. */
export function mapSwarmMemberState(state: string): AgentRowState {
  switch (state) {
    case 'working':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'stopped':
    case 'killed':
      return 'failed';
    default:
      return 'idle';
  }
}

/** Map a subagent progress state onto the dock's row states. */
export function mapSubagentState(state: string | undefined): AgentRowState {
  switch (state) {
    case 'running':
      return 'running';
    case 'completed':
      return 'done';
    case 'error':
    case 'cancelled':
      return 'failed';
    default:
      // Progress was emitted but the state has not settled yet.
      return 'running';
  }
}

export function formatElapsedShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function sortAgentRows(rows: readonly AgentRow[]): AgentRow[] {
  return [...rows].sort((a, b) => {
    const byState = STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state];
    if (byState !== 0) return byState;
    return a.name.localeCompare(b.name);
  });
}

export function countAgentStates(rows: readonly AgentRow[]): AgentStateCounts {
  const counts: AgentStateCounts = {
    running: 0,
    waiting: 0,
    idle: 0,
    done: 0,
    failed: 0,
  };
  for (const row of rows) {
    counts[row.state] += 1;
  }
  return counts;
}

/**
 * One text line for an agent: `◉ researcher  working  0:12  web_search`.
 * Truncates the trailing detail first so the name and state stay readable.
 */
export function formatAgentLine(row: AgentRow, width: number): string {
  const glyph = AGENT_GLYPH[row.state];
  const name = row.role ? `${row.name} · ${row.role}` : row.name;
  const elapsed =
    row.elapsedMs === undefined ? '' : formatElapsedShort(row.elapsedMs);
  const tail = [AGENT_STATE_LABEL[row.state], elapsed]
    .filter(Boolean)
    .join('  ');
  const base = `${glyph} ${name}  ${tail}`;
  if (!row.detail) return clip(base, width);
  const room = width - base.length - 2;
  if (room <= 2) return clip(base, width);
  return `${base}  ${clip(row.detail, room)}`;
}

export const DOCK_CHROME_ROWS = 3; // top border + header + bottom border
export const DOCK_MIN_ROWS = 6;
export const INLINE_DOCK_ROWS = 8;

export interface DockHeightOptions {
  /** Inline (non-alternate-buffer) mode uses a fixed block, not a fraction. */
  inline?: boolean;
  minRows?: number;
  maxFraction?: number;
}

/**
 * Height of the dock: what its content needs, clamped to a fraction of the
 * terminal so the chat keeps a usable area. Inline mode gets a fixed block to
 * avoid scrollback churn from <Static>.
 */
export function computeDockHeight(
  contentRows: number,
  terminalHeight: number,
  options: DockHeightOptions = {},
): number {
  const {
    inline = false,
    minRows = DOCK_MIN_ROWS,
    maxFraction = 1 / 3,
  } = options;
  const safeTerminal = Math.max(1, Math.floor(terminalHeight));
  const wanted = Math.max(minRows, Math.max(0, contentRows) + DOCK_CHROME_ROWS);
  const ceiling = Math.max(1, safeTerminal - 4);
  if (inline) {
    return Math.max(1, Math.min(INLINE_DOCK_ROWS, wanted, ceiling));
  }
  const cap = Math.max(minRows, Math.floor(safeTerminal * maxFraction));
  return Math.max(1, Math.min(wanted, cap, ceiling));
}

/** Rows available for content once the border and header are drawn. */
export function dockBodyRows(height: number): number {
  return Math.max(0, height - DOCK_CHROME_ROWS);
}

export interface WindowedAgentRows {
  visible: AgentRow[];
  hidden: number;
}

/** Keep the highest-priority rows (running first) and report the remainder. */
export function windowAgentRows(
  rows: readonly AgentRow[],
  maxRows: number,
): WindowedAgentRows {
  if (maxRows <= 0) {
    return { visible: [], hidden: rows.length };
  }
  if (rows.length <= maxRows) {
    return { visible: [...rows], hidden: 0 };
  }
  return {
    visible: rows.slice(0, maxRows),
    hidden: rows.length - maxRows,
  };
}

export interface AgentRowWindow {
  visible: AgentRow[];
  /** Rows hidden above the window. */
  hiddenBefore: number;
  /** Rows hidden below the window. */
  hiddenAfter: number;
  /** Largest scroll offset that still fills the window. */
  maxOffset: number;
}

/**
 * Window of rows for a pane that can be scrolled. `available` is the number
 * of rows the pane may use; one row is reserved for the scroll indicator when
 * the content does not fit.
 */
export function computePaneWindow(
  rows: readonly AgentRow[],
  available: number,
  requestedOffset: number,
): AgentRowWindow {
  const total = rows.length;
  if (total <= available) {
    return {
      visible: [...rows],
      hiddenBefore: 0,
      hiddenAfter: 0,
      maxOffset: 0,
    };
  }
  const maxVisible = Math.max(1, available - 1);
  const maxOffset = Math.max(0, total - maxVisible);
  const offset = Math.min(Math.max(0, requestedOffset), maxOffset);
  const visible = rows.slice(offset, offset + maxVisible);
  return {
    visible,
    hiddenBefore: offset,
    hiddenAfter: total - offset - visible.length,
    maxOffset,
  };
}

/** Scroll indicator for a window, or null when everything is visible. */
export function formatWindowFooter(window: AgentRowWindow): string | null {
  if (window.hiddenBefore === 0 && window.hiddenAfter === 0) return null;
  const parts: string[] = [];
  if (window.hiddenBefore > 0) parts.push(`↑ ${window.hiddenBefore} more`);
  if (window.hiddenAfter > 0) parts.push(`↓ ${window.hiddenAfter} more`);
  return parts.join(' · ');
}
