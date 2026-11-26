/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAgentDockState,
  resetAgentDock,
  setAgentDock,
  subscribeAgentDock,
  toggleAgentDock,
  toggleAgentDockView,
} from './agentDockStore.js';

describe('agentDockStore', () => {
  beforeEach(() => {
    resetAgentDock();
  });

  it('starts closed in split view on the subagents pane', () => {
    expect(getAgentDockState()).toEqual({
      open: false,
      view: 'split',
      pane: 'subagents',
    });
  });

  it('toggles open and closed', () => {
    toggleAgentDock();
    expect(getAgentDockState().open).toBe(true);
    toggleAgentDock();
    expect(getAgentDockState().open).toBe(false);
  });

  it('can force open or closed', () => {
    toggleAgentDock(true);
    expect(getAgentDockState().open).toBe(true);
    toggleAgentDock(true);
    expect(getAgentDockState().open).toBe(true);
    toggleAgentDock(false);
    expect(getAgentDockState().open).toBe(false);
  });

  it('switches between split and single view', () => {
    toggleAgentDockView();
    expect(getAgentDockState().view).toBe('single');
    toggleAgentDockView();
    expect(getAgentDockState().view).toBe('split');
  });

  it('notifies subscribers only when something changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentDock(listener);

    setAgentDock({ open: false });
    expect(listener).not.toHaveBeenCalled();

    setAgentDock({ open: true });
    expect(listener).toHaveBeenCalledTimes(1);

    setAgentDock({ open: true, view: 'split' });
    expect(listener).toHaveBeenCalledTimes(1);

    setAgentDock({ view: 'single', pane: 'swarm' });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setAgentDock({ open: false });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
