/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Height budget for the monitor panel. The panel lives in Ink's dynamic area
 * (below the prompt). If that area is taller than the terminal, Ink cannot
 * erase/redraw it: frames overlap, the view jumps to the top of the session
 * and the real terminal cursor (positioned relative to the bottom of the
 * output) lands on the wrong row. So the panel must always fit.
 */

/** Rows kept for everything else: agent bar, prompt box, footer, dock, chat. */
export const MONITOR_RESERVED_ROWS = 16;
export const MONITOR_MAX_ROWS = 18;
/** Below this budget the expanded view degrades to the 2-line view. */
export const MONITOR_MIN_EXPANDED_ROWS = 6;

export interface MonitorLayoutInput {
  terminalHeight: number;
  /** Agent task list (write_todos) items. Highest priority. */
  todos?: number;
  /** Number of steps (tool calls) in the current turn. */
  steps: number;
  /** Number of runner panes available (foreground/background). */
  runners: number;
  /** Output lines available for the first runner. */
  runnerLines: number;
  requests: number;
}

export interface MonitorLayout {
  view: 'hidden' | 'compact' | 'expanded';
  /** Total rows the panel may use. Always <= budget. */
  budget: number;
  /** Total rows the expanded view will actually use. */
  rows: number;
  steps: number;
  /** Rows of the agent task list (items only; header is extra). */
  todos: number;
  /** Rows (command line + output) for the runner section, 0 = hidden. */
  runnerRows: number;
  runnerOutput: number;
  requests: number;
  hint: boolean;
}

export function monitorBudget(terminalHeight: number): number {
  return Math.max(
    0,
    Math.min(
      MONITOR_MAX_ROWS,
      Math.floor(terminalHeight) - MONITOR_RESERVED_ROWS,
    ),
  );
}

const TODOS_WANT = 8;
const STEPS_WANT = 5;
const RUNNER_OUT_WANT = 3;
const REQUESTS_WANT = 6;

export function planMonitorLayout(i: MonitorLayoutInput): MonitorLayout {
  const budget = monitorBudget(i.terminalHeight);
  const none: MonitorLayout = {
    view: 'hidden',
    budget,
    rows: 0,
    steps: 0,
    todos: 0,
    runnerRows: 0,
    runnerOutput: 0,
    requests: 0,
    hint: false,
  };
  if (budget < 2) return none;
  if (budget < MONITOR_MIN_EXPANDED_ROWS) {
    return { ...none, view: 'compact', rows: 2 };
  }

  let left = budget - 1; // the TIMELINE row
  let todos = 0;
  let steps = 0;
  let runnerOutput = 0;
  let runnerRows = 0;
  let requests = 0;

  // Minimums in priority order: each costs a header row plus content.
  const todoCount = i.todos ?? 0;
  if (todoCount > 0 && left >= 2) {
    todos = 1;
    left -= 2;
  }
  if (i.steps > 0 && left >= 2) {
    steps = 1;
    left -= 2;
  }
  if (i.runners > 0 && left >= 2) {
    runnerRows = 1;
    left -= 2;
  }
  if (i.requests > 0 && left >= 2) {
    requests = 1;
    left -= 2;
  }
  // Extra rows, round-robin in the same priority order.
  const caps = {
    todos: Math.min(todoCount, TODOS_WANT),
    steps: Math.min(i.steps, STEPS_WANT),
    out: Math.min(i.runnerLines, RUNNER_OUT_WANT),
    req: Math.min(i.requests, REQUESTS_WANT),
  };
  let progressed = true;
  while (left > 0 && progressed) {
    progressed = false;
    if (todos > 0 && todos < caps.todos && left > 0) {
      todos++;
      left--;
      progressed = true;
    }
    if (steps > 0 && steps < caps.steps && left > 0) {
      steps++;
      left--;
      progressed = true;
    }
    if (runnerRows > 0 && runnerOutput < caps.out && left > 0) {
      runnerOutput++;
      left--;
      progressed = true;
    }
    if (requests > 0 && requests < caps.req && left > 0) {
      requests++;
      left--;
      progressed = true;
    }
  }
  const hint = left >= 1 && budget >= 12;
  if (hint) left--;

  const rows =
    1 +
    (todos > 0 ? 1 + todos : 0) +
    (steps > 0 ? 1 + steps : 0) +
    (runnerRows > 0 ? 1 + runnerRows + runnerOutput : 0) +
    (requests > 0 ? 1 + requests : 0) +
    (hint ? 1 : 0);
  return {
    view: 'expanded',
    budget,
    rows,
    steps,
    todos,
    runnerRows: runnerRows > 0 ? 1 : 0,
    runnerOutput,
    requests,
    hint,
  };
}
