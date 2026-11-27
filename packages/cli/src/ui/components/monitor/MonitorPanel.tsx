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
import { planMonitorLayout } from '../../utils/monitorLayout.js';
import { theme } from '../../semantic-colors.js';
import { SpecTimeline } from './SpecTimeline.js';

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

function ColoredTimeline({ timeline }: { timeline: string }) {
  return (
    <Text>
      {Array.from(timeline).map((ch, i) => {
        const state = GLYPH_STATES.find((k) => STATE_GLYPH[k] === ch);
        return (
          <Text key={i} color={state ? COLOR[state] : theme.text.secondary}>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
}

export const MonitorPanel: React.FC = () => {
  const mode = getAfotMonitorMode();
  const {
    pendingHistoryItems,
    history,
    terminalWidth,
    terminalHeight,
    backgroundTasks,
  } = useUIState();
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
  // Spec mode always renders (shows "create spec" prompt when no goal)
  if (
    mode !== 'spec' &&
    steps.length === 0 &&
    requests.length === 0 &&
    runners.length === 0
  ) {
    return null;
  }
  if (mode === 'compact' && steps.length === 0 && runners.length === 0) {
    return null;
  }

  const { done, total } = progressCounts(steps);
  const active = steps.find(
    (s) => s.state === 'running' || s.state === 'waiting',
  );
  const width = Math.max(20, terminalWidth - 2);
  const elapsed = (key: string): string => {
    const t = startedAt.current.get(key);
    return t === undefined ? '' : formatElapsed(Date.now() - t);
  };
  const mainRunner = runners.find((r) => r.status === 'running') ?? runners[0];
  const timeline = renderTimeline(steps, width - 8);

  // Checklist of steps
  const stepList = steps.map((s, i) => ({
    num: i + 1,
    label: s.label,
    state: s.state,
    elapsed: s.state === 'done' || s.state === 'running' ? elapsed(s.id) : '',
  }));

  const layout = planMonitorLayout({
    terminalHeight,
    steps: stepList.length,
    runners: runners.length,
    runnerLines: runners[0]?.lines.length ?? 0,
    requests: requests.length,
  });
  if (layout.view === 'hidden') return null;

  // ──────────────────────────────────────────────────────────────
  // SPEC TIMELINE VIEW
  // ──────────────────────────────────────────────────────────────
  if (mode === 'spec') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <SpecTimeline goal={null} terminalWidth={width} />
      </Box>
    );
  }

  // ──────────────────────────────────────────────────────────────
  // COLLAPSED VIEW (compact)
  // ──────────────────────────────────────────────────────────────
  if (mode === 'compact' || layout.view === 'compact') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <ColoredTimeline timeline={timeline} />
          <Text color={theme.text.secondary}>
            {'   '}
            {done}/{total}
          </Text>
        </Box>
        <Text color={theme.text.secondary} wrap="truncate-end">
          {mainRunner && mainRunner.status === 'running'
            ? `▸ running: ${clip(mainRunner.command, Math.max(10, width - 30))}${mainRunner.pid !== undefined ? `  pid ${mainRunner.pid}` : ''}  ${elapsed(mainRunner.key)}`
            : active
              ? `${STATE_GLYPH[active.state]} ${clip(active.label, width - 30)}`
              : 'idle'}
          {'   poll #'}
          {requests.length}
          {'   Alt+T expand'}
        </Text>
      </Box>
    );
  }

  // ──────────────────────────────────────────────────────────────
  // EXPANDED VIEW (height-budgeted: never taller than layout.rows)
  // ──────────────────────────────────────────────────────────────
  const shownSteps = stepList.slice(-layout.steps);
  const hiddenSteps = stepList.length - shownSteps.length;
  const shownRunner = runners[0];
  const shownRequests = requests.slice(0, layout.requests);
  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width={width + 2}
      height={layout.rows}
    >
      <Box>
        <Text bold color={theme.text.accent}>
          TIMELINE
        </Text>
        <Text> </Text>
        <ColoredTimeline timeline={timeline} />
        <Text color={theme.text.secondary}>
          {'   '}
          {total > 0 ? `${done}/${total}` : ''}
        </Text>
      </Box>

      {layout.steps > 0 && (
        <Box flexDirection="column">
          <Text bold color={theme.text.accent} wrap="truncate-end">
            STEPS{hiddenSteps > 0 ? ` (+${hiddenSteps} earlier)` : ''}
          </Text>
          {shownSteps.map((s) => (
            <Text key={s.num} color={COLOR[s.state]} wrap="truncate-end">
              {STATE_CHECK[s.state]} {s.num}. {clip(s.label, width - 14)}
              {s.elapsed ? `  ${s.elapsed}` : ''}
            </Text>
          ))}
        </Box>
      )}

      {layout.runnerRows > 0 && shownRunner && (
        <Box flexDirection="column">
          <Text bold color={theme.text.accent}>
            COMMAND RUNNER
          </Text>
          <Text
            color={
              shownRunner.status === 'running'
                ? theme.text.accent
                : shownRunner.exitCode === 0
                  ? theme.status.success
                  : theme.status.error
            }
            wrap="truncate-end"
          >
            {shownRunner.pid !== undefined ? `PID ${shownRunner.pid}  ` : ''}
            {clip(shownRunner.command, Math.max(10, width - 30))}
            {'  '}
            {shownRunner.status === 'running'
              ? `${shownRunner.source}  ${elapsed(shownRunner.key)}`
              : `exited ${shownRunner.exitCode ?? '?'}`}
          </Text>
          {shownRunner.lines.slice(-layout.runnerOutput).map((l, i) => (
            <Text key={i} color={theme.text.secondary} wrap="truncate-end">
              {'> '}
              {clip(l, width - 4)}
            </Text>
          ))}
        </Box>
      )}

      {layout.requests > 0 && (
        <Box flexDirection="column">
          <Text bold color={theme.text.accent}>
            POLLING / REQUESTS
          </Text>
          {shownRequests.map((r) => (
            <Text key={r.id} color={theme.text.secondary} wrap="truncate-end">
              {String(r.id).padStart(3)} {hhmmss(r.ts)} {r.type.padEnd(4)}{' '}
              {clip(r.target, 24).padEnd(24)} {r.status.padEnd(7)}
              {r.ms !== undefined ? `${r.ms}ms` : '—'}
            </Text>
          ))}
        </Box>
      )}

      {layout.hint && (
        <Text color={theme.text.secondary} wrap="truncate-end">
          Alt+T: compact / off
        </Text>
      )}
    </Box>
  );
};
