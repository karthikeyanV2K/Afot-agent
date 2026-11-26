/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { CoreToolCallStatus } from '@google/gemini-cli-core';
import type { IndividualToolCallDisplay } from '../types.js';
import type { BackgroundTask } from '../hooks/shellReducer.js';
import {
  formatElapsed,
  outputToLines,
  pickRunners,
  pollStatus,
  tailLines,
} from './monitorRunner.js';

const call = (
  o: Partial<IndividualToolCallDisplay>,
): IndividualToolCallDisplay =>
  ({
    callId: 'c1',
    name: 'run_shell_command',
    description: 'desc',
    resultDisplay: undefined,
    status: CoreToolCallStatus.Executing,
    confirmationDetails: undefined,
    ...o,
  }) as IndividualToolCallDisplay;

const task = (o: Partial<BackgroundTask>): BackgroundTask => ({
  pid: 1,
  command: 'sleep 9',
  output: '',
  isBinary: false,
  binaryBytesReceived: 0,
  status: 'running',
  ...o,
});

describe('monitorRunner', () => {
  it('flattens strings (stripping ANSI) and AnsiOutput', () => {
    expect(outputToLines('a\r\n\u001b[31mb\u001b[0m')).toEqual(['a', 'b']);
    expect(outputToLines([[{ text: 'he' }, { text: 'llo  ' }], []])).toEqual([
      'hello',
      '',
    ]);
    expect(outputToLines(42)).toEqual([]);
    expect(outputToLines([null, [{ text: 5 }]])).toEqual(['', '']);
  });

  it('tails and drops trailing blank lines', () => {
    expect(tailLines('1\n2\n3\n4\n\n\n', 2)).toEqual(['3', '4']);
    expect(tailLines('', 3)).toEqual([]);
  });

  it('picks the executing foreground shell with its command and tail', () => {
    const [r] = pickRunners(
      [
        call({
          args: { command: 'cargo test' },
          resultDisplay: 'l1\nl2\nl3',
          ptyId: 77,
        }),
        call({ callId: 'c2', status: CoreToolCallStatus.Success }),
      ],
      new Map(),
      2,
    );
    expect(r).toMatchObject({
      source: 'foreground',
      pid: 77,
      command: 'cargo test',
      lines: ['l2', 'l3'],
      totalLines: 3,
    });
  });

  it('lists running background tasks plus the latest exited one', () => {
    const tasks = new Map<number, BackgroundTask>([
      [1, task({ pid: 1, status: 'exited', exitCode: 0 })],
      [2, task({ pid: 2, status: 'exited', exitCode: 1 })],
      [3, task({ pid: 3, output: 'x' })],
    ]);
    const rs = pickRunners([], tasks, 3);
    expect(rs.map((r) => r.pid)).toEqual([3, 2]);
    expect(rs[1].exitCode).toBe(1);
  });

  it('does not print binary output', () => {
    const [r] = pickRunners(
      [],
      new Map([[1, task({ isBinary: true, binaryBytesReceived: 2048 })]]),
      3,
    );
    expect(r.lines[0]).toContain('binary');
    expect(pollStatus(r)).toBe('running 2048B');
  });

  it('poll status changes with output and exit', () => {
    const base = pickRunners(
      [],
      new Map([[1, task({ output: 'a\nb' })]]),
      3,
    )[0];
    expect(pollStatus(base)).toBe('running 2L');
    expect(pollStatus({ ...base, status: 'exited', exitCode: 3 })).toBe(
      'exited 3',
    );
  });

  it('formats elapsed time', () => {
    expect(formatElapsed(12_000)).toBe('12s');
    expect(formatElapsed(125_000)).toBe('2m05s');
    expect(formatElapsed(-5)).toBe('0s');
  });
});
