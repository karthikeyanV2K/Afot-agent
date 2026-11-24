/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { CoreToolCallStatus } from '@google/gemini-cli-core';
import { renderWithProviders } from '../../../test-utils/render.js';
import { MonitorPanel } from './MonitorPanel.js';
import type { HistoryItemWithoutId } from '../../types.js';

const item = (
  status: CoreToolCallStatus,
  id: string,
  description: string,
): HistoryItemWithoutId =>
  ({
    type: 'tool_group',
    tools: [
      {
        callId: id,
        name: 'run_shell_command',
        description,
        resultDisplay: undefined,
        status,
        confirmationDetails: undefined,
      },
    ],
  }) as unknown as HistoryItemWithoutId;

const pending = [
  item(CoreToolCallStatus.Success, 'a', 'read file'),
  item(CoreToolCallStatus.Executing, 'b', 'cargo test --lib'),
  item(CoreToolCallStatus.Scheduled, 'c', 'cargo clippy'),
];

describe('<MonitorPanel />', () => {
  afterEach(() => {
    delete process.env['AFOT_MONITOR'];
  });

  it('renders nothing when off', async () => {
    process.env['AFOT_MONITOR'] = 'off';
    const { lastFrame, unmount } = await renderWithProviders(<MonitorPanel />, {
      uiState: { pendingHistoryItems: pending },
    });
    expect(lastFrame({ allowEmpty: true }) ?? '').toBe('');
    unmount();
  });

  it('shows the timeline and active step in compact mode', async () => {
    process.env['AFOT_MONITOR'] = 'compact';
    const { lastFrame, unmount } = await renderWithProviders(<MonitorPanel />, {
      uiState: { pendingHistoryItems: pending },
    });
    const f = lastFrame() ?? '';
    expect(f).toContain('●──◉──○');
    expect(f).toContain('1/3');
    expect(f).toContain('cargo test --lib');
    unmount();
  });

  it('shows steps and requests when expanded', async () => {
    process.env['AFOT_MONITOR'] = 'expanded';
    const { lastFrame, unmount } = await renderWithProviders(<MonitorPanel />, {
      uiState: { pendingHistoryItems: pending },
    });
    const f = lastFrame() ?? '';
    expect(f).toContain('STEPS');
    expect(f).toContain('[x] read file');
    expect(f).toContain('[~] cargo test --lib');
    expect(f).toContain('[ ] cargo clippy');
    unmount();
  });
});

describe('<MonitorPanel /> runner', () => {
  afterEach(() => {
    delete process.env['AFOT_MONITOR'];
  });
  const running = {
    type: 'tool_group',
    tools: [
      {
        callId: 'r1',
        name: 'run_shell_command',
        description: 'cargo test',
        args: { command: 'cargo test --lib' },
        resultDisplay: 'running 3 tests\ntest a ... ok',
        ptyId: 4812,
        status: CoreToolCallStatus.Executing,
        confirmationDetails: undefined,
      },
    ],
  } as unknown as HistoryItemWithoutId;

  it('expanded shows the command runner with live output', async () => {
    process.env['AFOT_MONITOR'] = 'expanded';
    const { lastFrame, unmount } = await renderWithProviders(<MonitorPanel />, {
      uiState: { pendingHistoryItems: [running] },
    });
    const f = lastFrame() ?? '';
    expect(f).toContain('COMMAND RUNNER');
    expect(f).toContain('PID 4812');
    expect(f).toContain('cargo test --lib');
    expect(f).toContain('> test a ... ok');
    unmount();
  });

  it('compact shows the running command and pid', async () => {
    process.env['AFOT_MONITOR'] = 'compact';
    const { lastFrame, unmount } = await renderWithProviders(<MonitorPanel />, {
      uiState: { pendingHistoryItems: [running] },
    });
    const f = lastFrame() ?? '';
    expect(f).toContain('▸ running: cargo test --lib');
    expect(f).toContain('pid 4812');
    unmount();
  });
});
