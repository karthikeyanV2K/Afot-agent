/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useRef } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import { useUIState } from '../../contexts/UIStateContext.js';
import { useMouseClick } from '../../hooks/useMouseClick.js';
import { getLastTurnToolCalls } from '../../utils/historyUtils.js';
import {
  buildSteps,
  clip,
  progressCounts,
  renderTimeline,
  STATE_GLYPH,
  type StepState,
} from '../../utils/monitorTimeline.js';
import { theme } from '../../semantic-colors.js';
import { toggleAgentDock, useAgentDock } from './agentDockStore.js';
import type { AgentRoster } from './useAgentRoster.js';

const STEP_COLOR: Record<StepState, string> = {
  done: theme.status.success,
  running: theme.text.accent,
  pending: theme.text.secondary,
  failed: theme.status.error,
  waiting: theme.status.warning,
};

const STEP_STATES: readonly StepState[] = [
  'done',
  'running',
  'pending',
  'failed',
  'waiting',
];

export interface AgentBarProps {
  roster: AgentRoster;
}

/**
 * Always-visible one-line agent summary. It is the click target that opens the
 * dock, so it works even when /monitor is off (the MonitorPanel is hidden then).
 */
export const AgentBar: React.FC<AgentBarProps> = ({ roster }) => {
  const { open } = useAgentDock();
  const { history, pendingHistoryItems, terminalWidth } = useUIState();
  const containerRef = useRef<DOMElement | null>(null);

  useMouseClick(
    containerRef,
    useCallback(() => toggleAgentDock(), []),
  );

  const steps = useMemo(
    () => buildSteps(getLastTurnToolCalls(history ?? [], pendingHistoryItems)),
    [history, pendingHistoryItems],
  );
  const { done, total } = progressCounts(steps);

  const timelineWidth = Math.max(6, Math.min(20, terminalWidth - 52));
  const timeline = renderTimeline(steps, timelineWidth);

  const countLabel =
    roster.agentCount === 0
      ? 'no agents'
      : `${roster.agentCount} agent${roster.agentCount === 1 ? '' : 's'}${
          roster.runningCount > 0 ? ` · ${roster.runningCount} running` : ''
        }`;

  return (
    <Box
      ref={containerRef}
      height={1}
      flexShrink={0}
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate">
          <Text color={theme.text.accent}>{open ? '▾ ' : '▸ '}</Text>
          <Text bold color={theme.text.primary}>
            {clip(roster.title || 'Agents', 28)}
          </Text>
          <Text color={theme.text.secondary}> · {countLabel}</Text>
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text wrap="truncate">
          {timeline ? (
            <>
              {Array.from(timeline).map((ch, i) => {
                const state = STEP_STATES.find((k) => STATE_GLYPH[k] === ch);
                return (
                  <Text
                    key={i}
                    color={state ? STEP_COLOR[state] : theme.text.secondary}
                  >
                    {ch}
                  </Text>
                );
              })}
              <Text color={theme.text.secondary}>
                {' '}
                {done}/{total}
              </Text>
            </>
          ) : null}
          <Text color={theme.text.secondary}>
            {timeline ? '   ' : ''}
            {open ? 'Alt+A close' : 'Alt+A'}
          </Text>
        </Text>
      </Box>
    </Box>
  );
};
