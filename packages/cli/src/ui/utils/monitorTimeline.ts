/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoreToolCallStatus } from '@google/gemini-cli-core';

export type StepState = 'done' | 'running' | 'pending' | 'failed' | 'waiting';

export interface MonitorStep {
  id: string;
  label: string;
  state: StepState;
}

export interface TimelineInput {
  callId: string;
  name: string;
  description: string;
  status: CoreToolCallStatus;
}

export function stepState(status: CoreToolCallStatus): StepState {
  switch (status) {
    case CoreToolCallStatus.Success:
      return 'done';
    case CoreToolCallStatus.Executing:
      return 'running';
    case CoreToolCallStatus.Error:
    case CoreToolCallStatus.Cancelled:
      return 'failed';
    case CoreToolCallStatus.AwaitingApproval:
      return 'waiting';
    default:
      return 'pending';
  }
}

export function buildSteps(calls: readonly TimelineInput[]): MonitorStep[] {
  return calls.map((c) => ({
    id: c.callId,
    label: (c.description || c.name).replace(/\s+/g, ' ').trim(),
    state: stepState(c.status),
  }));
}

export const STATE_GLYPH: Record<StepState, string> = {
  done: '●',
  running: '◉',
  pending: '○',
  failed: '✗',
  waiting: '⚠',
};

export const STATE_CHECK: Record<StepState, string> = {
  done: '[x]',
  running: '[~]',
  pending: '[ ]',
  failed: '[!]',
  waiting: '[?]',
};

export function clip(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Horizontal timeline: ●──●──◉──○. A failed step ends the line so the
 * stop point is obvious. Windowed around the active step when too wide.
 */
export function renderTimeline(
  steps: readonly MonitorStep[],
  width: number,
): string {
  if (steps.length === 0) return '';
  const link = '──';
  const per = 1 + link.length;
  const maxNodes = Math.max(2, Math.floor((width + link.length) / per));
  let list = steps;
  let prefix = '';
  if (steps.length > maxNodes) {
    let active = steps.findIndex(
      (s) => s.state === 'running' || s.state === 'waiting',
    );
    if (active < 0) active = steps.length - 1;
    const keep = maxNodes - 1;
    const start = Math.min(
      Math.max(0, active - Math.floor(keep / 2)),
      steps.length - keep,
    );
    list = steps.slice(start, start + keep);
    prefix = '…';
  }
  const failedAt = list.findIndex((s) => s.state === 'failed');
  const shown = failedAt >= 0 ? list.slice(0, failedAt + 1) : list;
  return prefix + shown.map((s) => STATE_GLYPH[s.state]).join(link);
}

export function progressCounts(steps: readonly MonitorStep[]): {
  done: number;
  total: number;
} {
  return {
    done: steps.filter((s) => s.state === 'done').length,
    total: steps.length,
  };
}
