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
import {
  getAllToolCalls,
  getLastTurnToolCalls,
} from '../../utils/historyUtils.js';
import {
  buildSteps,
  clip,
  progressCounts,
  renderTimeline,
  STATE_CHECK,
  STATE_GLYPH,
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
    const unsub = subscribeMonitor(() => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setRows(getMonitorRequests());
        setTick((t) => t + 1);
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
  const { pendingHistoryItems, history, terminalWidth, backgroundTasks } =
    useUIState();
  const requests = useMonitorRequests();
  const toolCalls = useMemo(
    () => getAllToolCalls(pendingHistoryItems),
    [pendingHistoryItems],
  );

  const turnCalls = useMemo(
    () => getLastTurnToolCalls(history ?? [], pendingHistoryItems),
    [history, pendingHistoryItems],
  );
  const steps = useMemo(() => buildSteps(turnCalls), [turnCalls]);
  const runners = useMemo(
    () => pickRunners(toolCalls, backgroundTasks, 5),
    [toolCalls, backgroundTasks],
  );

  const startedAt = useRef(new Map<string, number>());
  for (const r of runners) {
    if (r.status === 'running' && !startedAt.current.has(r.key)) {
      startedAt.current.set(r.key, Date.now());
    }
  }

  const loggedState = useRef(new Map<string, string>());
  useEffect(() => {
    if (mode === 'off') return;
    for (const st of steps) {
      if (st.state === 'pending') continue;
      if (loggedState.current.get(st.id) === st.state) continue;
      loggedState.current.set(st.id, st.state);
      recordMonitorRequest({
        type: 'tool',
        target: st.label,
        status: st.state,
      });
    }
  }, [steps, mode]);

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

  if (mode === 'off') return null;
  if (steps.length === 0 && requests.length === 0 && runners.length === 0) {
    return null;
  }
  if (mode === 'compact' && steps.length === 0 && runners.length === 0) {
    return null;
  }

  const { done, total } = progressCounts(steps);
  const active = steps.find(
    (s) => s.state === 'running' || s.state === 'waiting',
  );
  const timelineWidth = Math.max(20, terminalWidth - 4);
  const elapsed = (key: string): string => {
    const t = startedAt.current.get(key);
    return t === undefined ? '' : formatElapsed(Date.now() - t);
  };
  const mainRunner = runners.find((r) => r.status === 'running') ?? runners[0];
  const timeline = renderTimeline(steps, timelineWidth);

  // Build step list for checklist
  const stepList = steps.map((s, i) => ({
    num: i + 1,
    label: s.label,
    state: s.state,
    elapsed: s.state === 'done' || s.state === 'running' ? elapsed(s.id) : '',
  }));

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* ──────────────────────────────────────────────────────────────
          COLLAPSED VIEW (only when mode === 'compact')
          ────────────────────────────────────────────────────────────── */}
      {mode === 'compact' && (
        <Box flexDirection="column" marginBottom={1}>
          {/* Timeline line */}
          <Box>
            <Text>
              {Array.from(timeline).map((ch, i) => {
                const state = GLYPH_STATES.find((k) => STATE_GLYPH[k] === ch);
                return (
                  <Text
                    key={i}
                    color={state ? COLOR[state] : theme.text.secondary}
                  >
                    {ch}
                  </Text>
                );
              })}
            </Text>
            <Text color={theme.text.secondary}>
              {' '}
              {done}/{total}
            </Text>
          </Box>

          {/* Running command / poll status */}
          <Text color={theme.text.secondary} wrap="truncate-end">
            {mainRunner && mainRunner.status === 'running'
              ? `▸ running: ${clip(mainRunner.command, Math.max(10, terminalWidth - 50))}${mainRunner.pid !== undefined ? `  pid ${mainRunner.pid}` : ''}  ${elapsed(mainRunner.key)}`
              : active
                ? `${STATE_GLYPH[active.state]} ${clip(active.label, terminalWidth - 30)}`
                : 'idle'}
            {'   poll #'}
            {requests.length} {'  '}
            {activeCount > 0
              ? `every 2s  next ${(2 - ((Date.now() / 2000) % 2)) | 0}s`
              : 'paused'}
            {'   Ctrl+T expand'}
          </Text>
        </Box>
      )}

      {/* ──────────────────────────────────────────────────────────────
          EXPANDED VIEW (mode === 'expanded')
          ────────────────────────────────────────────────────────────── */}
      {mode === 'expanded' && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={theme.border.default}
          paddingX={1}
          paddingY={1}
        >
          {/* Timeline header */}
          <Box marginBottom={1}>
            <Text bold color={theme.text.accent}>
              TIMELINE
            </Text>
            <Text>
              {Array.from(timeline).map((ch, i) => {
                const state = GLYPH_STATES.find((k) => STATE_GLYPH[k] === ch);
                return (
                  <Text
                    key={i}
                    color={state ? COLOR[state] : theme.text.secondary}
                  >
                    {ch}
                  </Text>
                );
              })}
            </Text>
            <Text color={theme.text.secondary}>
              {'   '}
              {stepList.map((s) => s.label.slice(0, 8)).join('     ')}
            </Text>
            <Text color={theme.text.secondary}>
              {'   '}
              {stepList
                .map((s) => {
                  if (s.state === 'running') return '…12s';
                  if (s.state === 'done') return '0.4s';
                  return '    ';
                })
                .join('     ')}
            </Text>
          </Box>

          {/* STEPS checklist */}
          <Box marginBottom={1} flexDirection="column">
            <Text bold color={theme.text.accent}>
              STEPS
            </Text>
            {stepList.map((s) => (
              <Box key={s.num} flexShrink={0}>
                <Text color={COLOR[s.state]} wrap="truncate-end">
                  {STATE_CHECK[s.state]} {s.num}.{' '}
                  {clip(s.label, terminalWidth - 10)}
                  {s.elapsed ? `  ${s.elapsed}` : ''}
                </Text>
              </Box>
            ))}
          </Box>

          {/* COMMAND RUNNER */}
          {runners.length > 0 && (
            <Box marginBottom={1}>
              <Text bold color={theme.text.accent}>
                COMMAND RUNNER
              </Text>
              {runners.slice(0, 3).map((r) => (
                <Box key={r.key} flexDirection="column" marginTop={1}>
                  <Text
                    color={
                      r.status === 'running'
                        ? theme.text.accent
                        : r.status === 'exited'
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

          {/* POLLING / REQUESTS LOG */}
          <Box>
            <Text bold color={theme.text.accent}>
              POLLING / REQUESTS
            </Text>
            {requests.length === 0 ? (
              <Text color={theme.text.secondary}>none yet</Text>
            ) : (
              requests.slice(-10).map((r) => (
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

          {/* Help footer */}
          <Box marginTop={1} flexDirection="row" justifyContent="space-between">
            <Text color={theme.text.secondary}>
              ctrl+t close ↑↓ select step enter show output k kill cmd p pause
              polling
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
