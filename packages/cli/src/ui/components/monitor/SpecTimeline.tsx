/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import {
  generateHeuristicPlan,
  shortenTitle,
  type SwarmPlan,
} from '@google/gemini-cli-core';

interface SpecPhase {
  id: string;
  name: string;
  tasks: SpecTask[];
  state: 'pending' | 'active' | 'done';
}

interface SpecTask {
  id: string;
  title: string;
  worker: string;
  brief: string;
  dependencies: string[];
  state: 'pending' | 'running' | 'done' | 'blocked';
  elapsedMs?: number;
}

interface SpecTimelineState {
  plan: SwarmPlan | null;
  phases: SpecPhase[];
  currentPhaseIndex: number;
  goal: string;
  createdAt: number;
  completedAt?: number;
}

const PHASE_COLOR = {
  pending: theme.text.secondary,
  active: theme.text.accent,
  done: theme.status.success,
};

const TASK_STATE_GLYPH = {
  pending: '○',
  running: '◉',
  done: '●',
  blocked: '⚠',
};

const TASK_STATE_COLOR = {
  pending: theme.text.secondary,
  running: theme.text.accent,
  done: theme.status.success,
  blocked: theme.status.warning,
};

function buildPhases(plan: SwarmPlan): SpecPhase[] {
  const phaseMap = new Map<string, SpecTask[]>();
  for (const task of plan.tasks) {
    const waveIdx = plan.waves.findIndex((w: string[]) => w.includes(task.id));
    const phaseKey = `Wave ${waveIdx + 1}`;
    if (!phaseMap.has(phaseKey)) phaseMap.set(phaseKey, []);
    phaseMap.get(phaseKey)!.push({
      id: task.id,
      title: task.title,
      worker: task.worker,
      brief: task.brief,
      dependencies: task.dependencies,
      state: 'pending',
    });
  }
  return Array.from(phaseMap.entries()).map(([name, tasks], idx) => ({
    id: `phase-${idx}`,
    name,
    tasks,
    state: idx === 0 ? 'active' : 'pending',
  }));
}

export interface SpecTimelineProps {
  /** Initial goal, or null to show the "create spec" prompt */
  goal?: string | null;
  /** Callback when user confirms the generated plan */
  onConfirm?: (plan: SwarmPlan) => void;
  /** Callback when user cancels */
  onCancel?: () => void;
  terminalWidth: number;
}

export const SpecTimeline: React.FC<SpecTimelineProps> = ({
  goal,
  onConfirm,
  onCancel,
  terminalWidth,
}) => {
  const [state, setState] = useState<SpecTimelineState | null>(null);
  const [showConfirm] = useState(false);
  const [pendingPlan] = useState<SwarmPlan | null>(null);
  // const startedAt = useRef<Map<string, number>>(new Map());

  // Initialize or regenerate plan when goal changes
  useMemo(() => {
    if (goal && !state) {
      const plan = generateHeuristicPlan(goal);
      const phases = buildPhases(plan);
      setState({
        plan,
        phases,
        currentPhaseIndex: 0,
        goal,
        createdAt: Date.now(),
      });
    }
  }, [goal, state]);

  const allTasks = state?.phases.flatMap((p) => p.tasks) ?? [];
  const doneTasks = allTasks.filter((t) => t.state === 'done').length;
  const totalTasks = allTasks.length;

  const formatElapsed = (ms?: number): string => {
    if (!ms || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  };

  const renderTask = (task: SpecTask, width: number) => {
    const glyph = TASK_STATE_GLYPH[task.state];
    const depStr = task.dependencies.length > 0 ? ` \u21B3 ${task.dependencies.join(', ')}` : '';
    const elapsed = task.elapsedMs ? ` ${formatElapsed(task.elapsedMs)}` : '';
    return (
      <Box key={task.id} flexDirection="row" marginLeft={2}>
        <Text color={TASK_STATE_COLOR[task.state]}>{glyph} </Text>
        <Text bold color={task.state === 'running' ? theme.text.accent : theme.text.primary}>
          {task.title}
        </Text>
        <Text color={theme.text.secondary}>
          {'  '}
          [{task.worker}]
          {depStr}
          {elapsed}
        </Text>
      </Box>
    );
  };

  if (!state) {
    // Show "create spec" prompt
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1} borderStyle="round" borderColor={theme.border.default}>
        <Text bold color={theme.text.accent}>SPEC TIMELINE</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>Enter a goal to generate a spec, e.g.:</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.accent}>/spec "rewrite the parser to rust"</Text>
        </Box>
        <Box>
          <Text color={theme.text.accent}>/spec "migrate auth to JWT with tests"</Text>
        </Box>
      </Box>
    );
  }

  if (showConfirm && pendingPlan) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1} borderStyle="round" borderColor={theme.border.default}>
        <Text bold color={theme.text.accent}>CONFIRM SPEC</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>Title: {pendingPlan.title}</Text>
        </Box>
        <Box>
          <Text color={theme.text.secondary}>Tasks: {pendingPlan.tasks.length} | Waves: {pendingPlan.waves.length}</Text>
        </Box>
        <Box flexDirection="row" marginTop={1}>
          <Box marginRight={2}>
            <Text color={theme.status.success}>[Y] Confirm</Text>
          </Box>
          <Box marginRight={2}>
            <Text color={theme.status.error}>[N] Cancel</Text>
          </Box>
          <Box>
            <Text color={theme.text.accent}>[E] Edit goal</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} borderStyle="round" borderColor={theme.border.default}>
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Box flexDirection="row">
          <Text bold color={theme.text.accent}>SPEC: </Text>
          <Text color={theme.text.primary}>{shortenTitle(state.goal)}</Text>
        </Box>
        <Text color={theme.text.secondary}>
          {doneTasks}/{totalTasks} done
        </Text>
      </Box>

      {/* Phases */}
      {state.phases.map((phase, idx) => (
        <Box key={phase.id} marginTop={idx === 0 ? 0 : 1} flexDirection="column">
          <Box flexDirection="row" alignItems="center">
            <Text
              bold={phase.state === 'active'}
              color={PHASE_COLOR[phase.state]}
            >
              {phase.state === 'done' ? '\u2713' : phase.state === 'active' ? '\u25B8' : '\u25CB'} {phase.name}
            </Text>
            <Box marginLeft={1}>
              <Text color={theme.text.secondary}>
                ({phase.tasks.filter((t) => t.state === 'done').length}/{phase.tasks.length})
              </Text>
            </Box>
          </Box>
          {phase.state !== 'pending' && (
            <Box flexDirection="column">
              {phase.tasks.map((task) => renderTask(task, terminalWidth - 6))}
            </Box>
          )}
        </Box>
      ))}

      {/* Progress bar */}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {'\u2588'.repeat(Math.floor((doneTasks / Math.max(1, totalTasks)) * 20))}
          {'\u2591'.repeat(20 - Math.floor((doneTasks / Math.max(1, totalTasks)) * 20))}
          {' '}
          {Math.round((doneTasks / Math.max(1, totalTasks)) * 100)}%
        </Text>
      </Box>

      {/* Controls */}
      <Box marginTop={1} flexDirection="row">
        <Box marginRight={2}>
          <Text color={theme.text.accent}>[N] Next phase</Text>
        </Box>
        <Box marginRight={2}>
          <Text color={theme.text.accent}>[T] Task done</Text>
        </Box>
        <Box>
          <Text color={theme.text.secondary}>[C] Cancel spec</Text>
        </Box>
      </Box>
    </Box>
  );
};