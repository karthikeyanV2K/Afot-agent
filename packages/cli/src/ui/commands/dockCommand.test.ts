/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { dockCommand } from './dockCommand.js';
import {
  getAgentDockState,
  resetAgentDock,
} from '../components/dock/agentDockStore.js';

const run = (args: string) =>
  dockCommand.action?.({} as never, args) as
    | { type: string; messageType?: string; content?: string }
    | undefined;

describe('dockCommand', () => {
  beforeEach(() => {
    resetAgentDock();
  });

  it('toggles the dock when called without arguments', () => {
    const result = run('');
    expect(getAgentDockState().open).toBe(true);
    expect(result?.messageType).toBe('info');
    expect(result?.content).toContain('open');
  });

  it('opens and closes explicitly', () => {
    run('open');
    expect(getAgentDockState().open).toBe(true);
    run('close');
    expect(getAgentDockState().open).toBe(false);
  });

  it('switches views', () => {
    run('single');
    expect(getAgentDockState()).toMatchObject({
      open: true,
      view: 'single',
    });
    run('split');
    expect(getAgentDockState().view).toBe('split');
    run('swarm');
    expect(getAgentDockState()).toMatchObject({
      open: true,
      view: 'single',
      pane: 'swarm',
    });
    run('subagents');
    expect(getAgentDockState().pane).toBe('subagents');
  });

  it('reports the status without changing anything', () => {
    run('status');
    expect(getAgentDockState().open).toBe(false);
    expect(run('status')?.content).toContain('closed');
  });

  it('rejects unknown options', () => {
    const result = run('nope');
    expect(result?.messageType).toBe('error');
    expect(getAgentDockState().open).toBe(false);
  });
});
