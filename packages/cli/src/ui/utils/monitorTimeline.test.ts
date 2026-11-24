/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { CoreToolCallStatus } from '@google/gemini-cli-core';
import {
  buildSteps,
  clip,
  progressCounts,
  renderTimeline,
  stepState,
  type MonitorStep,
} from './monitorTimeline.js';

const step = (
  state: MonitorStep['state'],
  id: string = state,
): MonitorStep => ({
  id,
  label: id,
  state,
});

describe('monitorTimeline', () => {
  it('maps tool statuses to step states', () => {
    expect(stepState(CoreToolCallStatus.Success)).toBe('done');
    expect(stepState(CoreToolCallStatus.Executing)).toBe('running');
    expect(stepState(CoreToolCallStatus.Error)).toBe('failed');
    expect(stepState(CoreToolCallStatus.Cancelled)).toBe('failed');
    expect(stepState(CoreToolCallStatus.AwaitingApproval)).toBe('waiting');
    expect(stepState(CoreToolCallStatus.Scheduled)).toBe('pending');
  });

  it('builds labels from the description and collapses whitespace', () => {
    const [s] = buildSteps([
      {
        callId: 'a',
        name: 'run_shell_command',
        description: 'cargo   test\n--lib',
        status: CoreToolCallStatus.Success,
      },
    ]);
    expect(s).toEqual({ id: 'a', label: 'cargo test --lib', state: 'done' });
  });

  it('renders a horizontal timeline', () => {
    expect(
      renderTimeline(
        [step('done', '1'), step('running', '2'), step('pending', '3')],
        80,
      ),
    ).toBe('●──◉──○');
  });

  it('stops the line at the first failed step', () => {
    expect(
      renderTimeline(
        [step('done', '1'), step('failed', '2'), step('pending', '3')],
        80,
      ),
    ).toBe('●──✗');
  });

  it('windows around the active step when too wide', () => {
    const steps = Array.from({ length: 30 }, (_, i) =>
      step(i < 15 ? 'done' : i === 15 ? 'running' : 'pending', String(i)),
    );
    const out = renderTimeline(steps, 20);
    expect(out.startsWith('…')).toBe(true);
    expect(out).toContain('◉');
    expect(Array.from(out).length).toBeLessThanOrEqual(21);
  });

  it('handles empty input and counts', () => {
    expect(renderTimeline([], 40)).toBe('');
    expect(progressCounts([step('done', 'a'), step('pending', 'b')])).toEqual({
      done: 1,
      total: 2,
    });
  });

  it('clips text', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 4)).toBe('abc');
  });
});
