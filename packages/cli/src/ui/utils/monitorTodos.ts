/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem, HistoryItemWithoutId } from '../types.js';

export type TodoState =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'blocked';

export interface MonitorTodo {
  description: string;
  status: TodoState;
}

type Item = HistoryItem | HistoryItemWithoutId;

function todosFromItem(item: Item): MonitorTodo[] | null {
  if (item.type !== 'tool_group') return null;
  // newest tool first
  for (let j = item.tools.length - 1; j >= 0; j--) {
    const d = item.tools[j].resultDisplay;
    if (d && typeof d === 'object' && 'todos' in d && Array.isArray(d.todos)) {
      return d.todos as MonitorTodo[];
    }
  }
  return null;
}

/**
 * The agent's real task list: the most recent write_todos result, searching
 * pending (live) items first, then history. Returns [] if none.
 */
export function getLatestTodos(
  history: readonly HistoryItem[],
  pending: readonly HistoryItemWithoutId[],
): MonitorTodo[] {
  for (let i = pending.length - 1; i >= 0; i--) {
    const t = todosFromItem(pending[i]);
    if (t) return t;
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const t = todosFromItem(history[i]);
    if (t) return t;
  }
  return [];
}

export const TODO_CHECK: Record<TodoState, string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
  cancelled: '[-]',
  blocked: '[!]',
};

/** Keep the active item visible when only n rows are available. */
export function windowTodos(
  todos: readonly MonitorTodo[],
  n: number,
): { shown: MonitorTodo[]; hidden: number } {
  if (n <= 0) return { shown: [], hidden: todos.length };
  if (todos.length <= n) return { shown: [...todos], hidden: 0 };
  let a = todos.findIndex((t) => t.status === 'in_progress');
  if (a < 0) a = todos.findIndex((t) => t.status === 'pending');
  if (a < 0) a = todos.length - 1;
  const start = Math.min(Math.max(0, a - 1), todos.length - n);
  return {
    shown: todos.slice(start, start + n),
    hidden: todos.length - n,
  };
}
