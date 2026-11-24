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
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    // Throttle to ~4 fps so a chatty stream cannot make the TUI flicker.
    const unsub = subscribeMonitor(() => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setRows(getMonitorRequests());
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
  const { pendingHistoryItems, terminalWidth } = useUIState();
  const requests = useMonitorRequests();

  const live = useMemo(
    () => buildSteps(getAllToolCalls(pendingHistoryItems)),
    [pendingHistoryItems],
  );
  // Keep the last turn visible after it finishes.
  const lastSteps = useRef<MonitorStep[]>([]);
  if (live.length > 0) lastSteps.current = live;
  const steps = live.length > 0 ? live : lastSteps.current;

  if (mode === 'off') return null;
  if (steps.length === 0 && requests.length === 0) return null;

  const { done, total } = progressCounts(steps);
  const active = steps.find(
    (s) => s.state === 'running' || s.state === 'waiting',
  );
  const width = Math.max(20, terminalWidth - 24);
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
          {active
            ? `${STATE_GLYPH[active.state]} ${clip(active.label, terminalWidth - 30)}`
            : 'idle'}
          {'   /monitor expanded for details'}
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
