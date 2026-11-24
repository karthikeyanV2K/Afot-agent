/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import {
  getAfotMonitorMode,
  getMonitorRequests,
  recordMonitorPoll,
  recordMonitorRequest,
  subscribeMonitor,
  type MonitorRequest,
} from '@google/gemini-cli-core';
import { useUIState } from '../../contexts/UIStateContext.js';
import { getAllToolCalls } from '../../utils/historyUtils.js';
import {
  buildSteps,
  clip,
  progressCounts,
  renderTimeline,
  STATE_CHECK,
  STATE_GLYPH,
  type MonitorStep,
  type StepState,
} from '../../utils/monitorTimeline.js';
import {
  formatElapsed,
  pickRunners,
  pollStatus,
} from '../../utils/monitorRunner.js';
import { theme } from '../../semantic-colors.js';

const COLOR: Record<StepState, string> = {
  done: theme.status.success,
  running: theme.text.accent,
  pending: theme.text.secondary,
  failed: theme.status.error,
  waiting: theme.status.warning,
};

const GLYPH_STATES: readonly StepState[] = [
  'done',
  'running',
  'pending',
  'failed',
  'waiting',
];

function hhmmss(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

function useMonitorRequests(): MonitorRequest[] {
  const [rows, setRows] = useState<MonitorRequest[]>(() =>
    getMonitorRequests(),
  );
  const [, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    // Throttle to ~4 fps so a chatty stream cannot make the TUI flicker.
    const unsub = subscribeMonitor(() => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setRows(getMonitorRequests());
        setTick((t) => t + 1); // re-read the monitor mode too
      }, 250);
    });
    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  return rows;
}

export const MonitorPanel: React.FC = () => {
  const mode = getAfotMonitorMode();
  const { pendingHistoryItems, terminalWidth, backgroundTasks } = useUIState();
  const requests = useMonitorRequests();
  const toolCalls = useMemo(
    () => getAllToolCalls(pendingHistoryItems),
    [pendingHistoryItems],
  );

  const live = useMemo(() => buildSteps(toolCalls), [toolCalls]);
  const runners = useMemo(
    () => pickRunners(toolCalls, backgroundTasks, 5),
    [toolCalls, backgroundTasks],
  );

  // Elapsed time per runner, from when the panel first saw it running.
  const startedAt = useRef(new Map<string, number>());
  for (const r of runners) {
    if (r.status === 'running' && !startedAt.current.has(r.key)) {
      startedAt.current.set(r.key, Date.now());
    }
  }

  // Log tool state changes once each.
  const loggedState = useRef(new Map<string, string>());
  useEffect(() => {
    if (mode === 'off') return;
    for (const st of live) {
      if (st.state === 'pending') continue;
      if (loggedState.current.get(st.id) === st.state) continue;
      loggedState.current.set(st.id, st.state);
      recordMonitorRequest({
        type: 'tool',
        target: st.label,
        status: st.state,
      });
    }
  }, [live, mode]);

  // Poll running processes every 2s; a row is logged only when status changes.
  const runnersRef = useRef(runners);
  runnersRef.current = runners;
  const activeCount = runners.filter((r) => r.status === 'running').length;
  useEffect(() => {
    if (mode === 'off' || activeCount === 0) return;
    const poll = () => {
      for (const r of runnersRef.current) {
        recordMonitorPoll(
          r.pid !== undefined ? `pid ${r.pid}` : r.command.slice(0, 24),
          pollStatus(r),
        );
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [mode, activeCount]);
  // Keep the last turn visible after it finishes.
  const lastSteps = useRef<MonitorStep[]>([]);
  if (live.length > 0) lastSteps.current = live;
  const steps = live.length > 0 ? live : lastSteps.current;

  if (mode === 'off') return null;
  if (steps.length === 0 && requests.length === 0 && runners.length === 0) {
    return null;
  }

  const { done, total } = progressCounts(steps);
  const active = steps.find(
    (s) => s.state === 'running' || s.state === 'waiting',
  );
  const width = Math.max(20, terminalWidth - 24);
  const elapsed = (key: string): string => {
    const t = startedAt.current.get(key);
    return t === undefined ? '' : formatElapsed(Date.now() - t);
  };
  const main = runners.find((r) => r.status === 'running') ?? runners[0];
  const line = renderTimeline(steps, width);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text>
          {Array.from(line).map((ch, i) => {
            const state = GLYPH_STATES.find((k) => STATE_GLYPH[k] === ch);
            return (
              <Text key={i} color={state ? COLOR[state] : theme.text.secondary}>
                {ch}
              </Text>
            );
          })}
        </Text>
        <Text color={theme.text.secondary}>
          {'   '}
          {done}/{total}
        </Text>
      </Box>
      {mode === 'compact' ? (
        <Text color={theme.text.secondary} wrap="truncate-end">
          {main && main.status === 'running'
            ? `▸ running: ${clip(main.command, Math.max(10, terminalWidth - 50))}${main.pid !== undefined ? `  pid ${main.pid}` : ''}  ${elapsed(main.key)}`
            : active
              ? `${STATE_GLYPH[active.state]} ${clip(active.label, terminalWidth - 30)}`
              : 'idle'}
          {'   Alt+T more'}
        </Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.accent}>
            STEPS
          </Text>
          {steps.slice(-8).map((s) => (
            <Text key={s.id} color={COLOR[s.state]} wrap="truncate-end">
              {STATE_CHECK[s.state]} {clip(s.label, terminalWidth - 8)}
            </Text>
          ))}
          {runners.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color={theme.text.accent}>
                COMMAND RUNNER
              </Text>
              {runners.slice(0, 2).map((r) => (
                <Box key={r.key} flexDirection="column">
                  <Text
                    color={
                      r.status === 'running'
                        ? theme.text.accent
                        : r.exitCode === 0
                          ? theme.status.success
                          : theme.status.error
                    }
                    wrap="truncate-end"
                  >
                    {r.pid !== undefined ? `PID ${r.pid}  ` : ''}
                    {clip(r.command, Math.max(10, terminalWidth - 40))}
                    {'  '}
                    {r.status === 'running'
                      ? `${r.source}  ${elapsed(r.key)}`
                      : `exited ${r.exitCode ?? '?'}`}
                  </Text>
                  {r.lines.map((l, i) => (
                    <Text
                      key={i}
                      color={theme.text.secondary}
                      wrap="truncate-end"
                    >
                      {'> '}
                      {l}
                    </Text>
                  ))}
                </Box>
              ))}
            </Box>
          )}
          <Box marginTop={1} flexDirection="column">
            <Text bold color={theme.text.accent}>
              REQUESTS
            </Text>
            {requests.length === 0 ? (
              <Text color={theme.text.secondary}>none yet</Text>
            ) : (
              requests.map((r) => (
                <Text
                  key={r.id}
                  color={theme.text.secondary}
                  wrap="truncate-end"
                >
                  {String(r.id).padStart(3)} {hhmmss(r.ts)} {r.type.padEnd(4)}{' '}
                  {clip(r.target, 28).padEnd(28)} {r.status.padEnd(7)}
                  {r.ms !== undefined ? `${r.ms}ms`.padStart(8) : '       —'}
                  {r.tokensIn !== undefined
                    ? `  ${r.tokensIn}→${r.tokensOut ?? 0}`
                    : ''}
                </Text>
              ))
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};
