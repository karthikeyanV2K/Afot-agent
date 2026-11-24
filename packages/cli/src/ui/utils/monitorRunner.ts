/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoreToolCallStatus } from '@google/gemini-cli-core';
import type { IndividualToolCallDisplay } from '../types.js';
import type { BackgroundTask } from '../hooks/shellReducer.js';

export interface RunnerInfo {
  key: string;
  source: 'foreground' | 'background';
  pid?: number;
  command: string;
  status: 'running' | 'exited';
  exitCode?: number;
  lines: string[];
  /** Total lines seen so far (the tail in `lines` is capped). */
  totalLines: number;
}

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[a-zA-Z]', 'g');

/** Plain-text lines from a string or an AnsiOutput-like value. Never throws. */
export function outputToLines(output: unknown): string[] {
  try {
    if (typeof output === 'string') {
      return output.replace(ANSI, '').split(/\r?\n/);
    }
    if (Array.isArray(output)) {
      return output.map((line: unknown) =>
        Array.isArray(line)
          ? line
              .map((t: unknown) =>
                typeof t === 'object' &&
                t !== null &&
                'text' in t &&
                typeof t.text === 'string'
                  ? t.text
                  : '',
              )
              .join('')
              .trimEnd()
          : '',
      );
    }
  } catch {
    // fall through
  }
  return [];
}

export function tailLines(output: unknown, n: number): string[] {
  const lines = outputToLines(output);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.slice(-Math.max(0, n));
}

function commandOf(c: IndividualToolCallDisplay): string {
  const arg = c.args?.['command'];
  return typeof arg === 'string' && arg ? arg : c.description || c.name;
}

/**
 * Chooses what the runner pane shows: running foreground shell first, then
 * running background tasks, then the most recent exited background task.
 */
export function pickRunners(
  calls: readonly IndividualToolCallDisplay[],
  tasks: ReadonlyMap<number, BackgroundTask>,
  tail: number,
): RunnerInfo[] {
  const out: RunnerInfo[] = [];
  for (const c of calls) {
    if (c.status !== CoreToolCallStatus.Executing) continue;
    if (c.resultDisplay === undefined && c.ptyId === undefined) continue;
    out.push({
      key: `fg:${c.callId}`,
      source: 'foreground',
      pid: c.ptyId,
      command: commandOf(c),
      status: 'running',
      lines: tailLines(c.resultDisplay, tail),
      totalLines: outputToLines(c.resultDisplay).length,
    });
  }
  const bg = Array.from(tasks.values());
  const running = bg.filter((t) => t.status === 'running');
  const exited = bg.filter((t) => t.status === 'exited').slice(-1);
  for (const t of [...running, ...exited]) {
    out.push({
      key: `bg:${t.pid}`,
      source: 'background',
      pid: t.pid,
      command: t.command,
      status: t.status,
      exitCode: t.exitCode,
      lines: t.isBinary
        ? [`(binary output, ${t.binaryBytesReceived} bytes)`]
        : tailLines(t.output, tail),
      totalLines: t.isBinary ? t.binaryBytesReceived : outputToLines(t.output).length,
    });
  }
  return out;
}

/** Poll status string; changes whenever the process state or output size changes. */
export function pollStatus(r: RunnerInfo): string {
  return r.status === 'running'
    ? `running ${r.totalLines}${r.lines[0]?.startsWith('(binary') ? 'B' : 'L'}`
    : `exited ${r.exitCode ?? '?'}`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
