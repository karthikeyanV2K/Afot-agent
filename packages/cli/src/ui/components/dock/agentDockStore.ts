/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';

export type AgentDockView = 'single' | 'split';
export type AgentDockPane = 'subagents' | 'swarm';

export interface AgentDockState {
  /** Whether the dock is expanded below the prompt. */
  open: boolean;
  /** Split shows Subagents | Swarm side by side; single shows one pane. */
  view: AgentDockView;
  /** Which pane a single view shows. */
  pane: AgentDockPane;
}

const INITIAL_STATE: AgentDockState = {
  open: false,
  view: 'split',
  pane: 'subagents',
};

let state: AgentDockState = INITIAL_STATE;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeAgentDock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentDockState(): AgentDockState {
  return state;
}

export function setAgentDock(next: Partial<AgentDockState>): void {
  const merged: AgentDockState = { ...state, ...next };
  if (
    merged.open === state.open &&
    merged.view === state.view &&
    merged.pane === state.pane
  ) {
    return;
  }
  state = merged;
  emit();
}

export function toggleAgentDock(force?: boolean): void {
  setAgentDock({ open: force ?? !state.open });
}

export function toggleAgentDockView(): void {
  setAgentDock({ view: state.view === 'split' ? 'single' : 'split' });
}

export function resetAgentDock(): void {
  state = INITIAL_STATE;
  emit();
}

/** React binding for the module-level dock state. */
export function useAgentDock(): AgentDockState {
  return useSyncExternalStore(
    subscribeAgentDock,
    getAgentDockState,
    getAgentDockState,
  );
}
