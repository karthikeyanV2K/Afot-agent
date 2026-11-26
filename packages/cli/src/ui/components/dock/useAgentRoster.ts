/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AfotSwarmManager,
  isSubagentProgress,
  type SwarmBoardPost,
  type SwarmRosterStatus,
} from '@google/gemini-cli-core';
import { useConfig } from '../../contexts/ConfigContext.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { getLastTurnToolCalls } from '../../utils/historyUtils.js';
import {
  countAgentStates,
  mapSubagentState,
  mapSwarmMemberState,
  sortAgentRows,
  type AgentRow,
  type AgentRowState,
  type AgentStateCounts,
} from './agentDockModel.js';

export interface AgentRoster {
  /** Auto-name from AfotSwarmManager.getTitle(). */
  title: string;
  subagents: AgentRow[];
  swarm: AgentRow[];
  board: readonly SwarmBoardPost[];
  totalPosts: number;
  /** Unique agent names across both panes, for the collapsed bar. */
  agentCount: number;
  runningCount: number;
  subagentCounts: AgentStateCounts;
  swarmCounts: AgentStateCounts;
}

function statusSignature(status: SwarmRosterStatus): string {
  const members = status.members
    .map((m) => `${m.name}:${m.state}:${m.lastActiveAt ?? 0}`)
    .join(',');
  const lastPost = status.recentPosts[status.recentPosts.length - 1];
  return `${status.title}|${status.totalPosts}|${lastPost?.seq ?? 0}|${members}`;
}

function definitionName(def: { name: string; displayName?: string }): string {
  return def.displayName ?? def.name;
}

export function useAgentRoster(): AgentRoster {
  const config = useConfig();
  const { history, pendingHistoryItems } = useUIState();

  const [now, setNow] = useState(() => Date.now());
  const startedAt = useRef(new Map<string, number>());
  const lastState = useRef(new Map<string, AgentRowState>());

  // Live subagent progress from the current turn's tool calls.
  const live = useMemo(() => {
    const calls = getLastTurnToolCalls(history ?? [], pendingHistoryItems);
    const agents = new Map<
      string,
      { name: string; state: AgentRowState; detail?: string }
    >();
    for (const call of calls) {
      const progress = call.resultDisplay;
      if (!isSubagentProgress(progress)) continue;
      const name = progress.agentName?.trim();
      if (!name) continue;
      const state = mapSubagentState(progress.state);
      const last =
        progress.recentActivity?.[progress.recentActivity.length - 1];
      const detail = last?.displayName ?? last?.content;
      const key = name.toLowerCase();
      const previous = agents.get(key);
      // A running observation wins over a stale completed one.
      if (!previous || previous.state !== 'running') {
        agents.set(key, { name, state, detail });
      }
    }
    return agents;
  }, [history, pendingHistoryItems]);

  // Swarm roster: poll once a second and only re-render when it changes.
  const [status, setStatus] = useState<SwarmRosterStatus>(() =>
    AfotSwarmManager.getInstance().getStatus(),
  );
  const statusRef = useRef(status);
  useEffect(() => {
    const manager = AfotSwarmManager.getInstance();
    const read = () => {
      const next = manager.getStatus();
      if (statusSignature(next) !== statusSignature(statusRef.current)) {
        statusRef.current = next;
        setStatus(next);
      }
    };
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, []);

  const trackElapsed = (
    name: string,
    state: AgentRowState,
  ): number | undefined => {
    const key = name.toLowerCase();
    const wasRunning = lastState.current.get(key) === 'running';
    if (state === 'running') {
      if (!wasRunning || !startedAt.current.has(key)) {
        startedAt.current.set(key, now);
      }
      lastState.current.set(key, state);
      return Math.max(0, now - (startedAt.current.get(key) ?? now));
    }
    lastState.current.set(key, state);
    return undefined;
  };

  const subagents = useMemo(() => {
    const rows: AgentRow[] = [];
    const seen = new Set<string>();

    for (const agent of live.values()) {
      const key = agent.name.toLowerCase();
      seen.add(key);
      rows.push({
        key: `live:${key}`,
        name: agent.name,
        state: agent.state,
        detail: agent.detail,
        elapsedMs: trackElapsed(agent.name, agent.state),
      });
    }

    const registry = config.getAgentRegistry?.();
    const definitions =
      typeof registry?.getAllDefinitions === 'function'
        ? registry.getAllDefinitions()
        : [];
    for (const def of definitions) {
      const key = def.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        key: `def:${key}`,
        name: definitionName(def),
        role: def.name,
        state: 'idle',
      });
    }

    return sortAgentRows(rows);
    // trackElapsed reads refs and `now`; both are intentionally part of this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, config, now]);

  const swarm = useMemo(
    () =>
      sortAgentRows(
        status.members.map((member) => ({
          key: `swarm:${member.name.toLowerCase()}`,
          name: member.name,
          role: member.role,
          state: mapSwarmMemberState(member.state),
          detail: member.brief,
          elapsedMs: trackElapsed(
            member.name,
            mapSwarmMemberState(member.state),
          ),
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status.members, now],
  );

  const board = useMemo(() => status.recentPosts.slice(-3), [status]);

  const anyRunning =
    subagents.some((row) => row.state === 'running') ||
    swarm.some((row) => row.state === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const subagentCounts = useMemo(
    () => countAgentStates(subagents),
    [subagents],
  );
  const swarmCounts = useMemo(() => countAgentStates(swarm), [swarm]);

  const { agentCount, runningCount } = useMemo(() => {
    const names = new Set<string>();
    const running = new Set<string>();
    for (const row of [...subagents, ...swarm]) {
      const key = row.name.toLowerCase();
      names.add(key);
      if (row.state === 'running') running.add(key);
    }
    return { agentCount: names.size, runningCount: running.size };
  }, [subagents, swarm]);

  return {
    title: status.title,
    subagents,
    swarm,
    board,
    totalPosts: status.totalPosts,
    agentCount,
    runningCount,
    subagentCounts,
    swarmCounts,
  };
}
