/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { AgentBar } from './AgentBar.js';
import { AgentDock } from './AgentDock.js';
import { resetAgentDock, setAgentDock } from './agentDockStore.js';
import type { AgentRoster } from './useAgentRoster.js';

const roster: AgentRoster = {
  title: 'Refactor the parser',
  subagents: [
    {
      key: 'live:researcher',
      name: 'researcher',
      state: 'running',
      detail: 'web_search',
      elapsedMs: 12_000,
    },
    { key: 'def:coder', name: 'coder', role: 'coder', state: 'idle' },
  ],
  swarm: [
    {
      key: 'swarm:coordinator',
      name: 'coordinator',
      role: 'generalist',
      state: 'waiting',
      detail: 'Swarm Coordinator and Dispatcher',
    },
    {
      key: 'swarm:explorer',
      name: 'explorer',
      role: 'explorer',
      state: 'running',
    },
  ],
  board: [
    {
      seq: 7,
      sender: 'coordinator',
      text: '@explorer look at src/parser.ts',
      timestamp: Date.now(),
    },
  ],
  totalPosts: 1,
  agentCount: 3,
  runningCount: 2,
  subagentCounts: { running: 1, waiting: 0, idle: 1, done: 0, failed: 0 },
  swarmCounts: { running: 1, waiting: 1, idle: 0, done: 0, failed: 0 },
};

describe('agent dock components', () => {
  beforeEach(() => {
    resetAgentDock();
  });

  it('renders the one-line bar with the swarm title and counts', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <AgentBar roster={roster} />,
      { width: 80 },
    );
    const frame = lastFrame();
    expect(frame).toContain('Refactor the parser');
    expect(frame).toContain('3 agents');
    expect(frame).toContain('2 running');
    expect(frame).toContain('Alt+A');
    expect(frame.trimEnd().split('\n')).toHaveLength(1);
    unmount();
  });

  it('renders nothing while the dock is closed', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <AgentDock roster={roster} />,
      { width: 80 },
    );
    expect(lastFrame({ allowEmpty: true })).toBe('');
    unmount();
  });

  it('shows both panes in split view', async () => {
    setAgentDock({ open: true, view: 'split' });
    const { lastFrame, unmount } = await renderWithProviders(
      <AgentDock roster={roster} />,
      { width: 80 },
    );
    const frame = lastFrame();
    expect(frame).toContain('Subagents');
    expect(frame).toContain('Refactor the parser');
    expect(frame).toContain('researcher');
    expect(frame).toContain('coder');
    expect(frame).toContain('coordinator');
    expect(frame).toContain('explorer');
    expect(frame).toContain('board');
    unmount();
  });

  it('shows a single pane when the view is switched', async () => {
    setAgentDock({ open: true, view: 'single', pane: 'swarm' });
    const { lastFrame, unmount } = await renderWithProviders(
      <AgentDock roster={roster} />,
      { width: 80 },
    );
    const frame = lastFrame();
    expect(frame).toContain('coordinator');
    expect(frame).toContain('explorer');
    expect(frame).not.toContain('researcher');
    unmount();
  });

  it('windows rows that do not fit and reports the remainder', async () => {
    const many = {
      ...roster,
      subagents: Array.from({ length: 20 }, (_, i) => ({
        key: `live:a${i}`,
        name: `agent-${i}`,
        state: 'idle' as const,
      })),
    };
    setAgentDock({ open: true, view: 'single', pane: 'subagents' });
    const { lastFrame, unmount } = await renderWithProviders(
      <AgentDock roster={many} />,
      { width: 80, uiState: { terminalHeight: 12 } },
    );
    const frame = lastFrame();
    expect(frame).toContain('↓');
    expect(frame).toContain('more');
    unmount();
  });
});
