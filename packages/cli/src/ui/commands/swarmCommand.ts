/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import {
  AfotSwarmOrchestrator,
  coreEvents,
  debugLogger,
  type SwarmPlan,
} from '@google/gemini-cli-core';
import { MessageType } from '../types.js';

function formatPlanDisplay(plan: SwarmPlan): string {
  const lines: string[] = [
    `## 🌊 AFOT Parallel Swarm Plan`,
    `**Goal:** ${plan.goal}`,
    `**Tasks:** ${plan.tasks.length} | **Waves:** ${plan.waves.length}`,
    '',
  ];

  for (let w = 0; w < plan.waves.length; w++) {
    const waveTaskIds = plan.waves[w];
    const waveNum = w + 1;
    const isParallel = waveTaskIds.length > 1;
    lines.push(
      `### ⚡ Wave ${waveNum}${
        isParallel ? ' (Parallel Concurrent Execution)' : ''
      }:`,
    );
    for (const taskId of waveTaskIds) {
      const task = plan.tasks.find((t) => t.id === taskId);
      if (!task) continue;
      const deps =
        task.dependencies.length > 0
          ? ` *(depends on: ${task.dependencies.join(', ')})*`
          : '';
      lines.push(
        `- **[${task.worker}]** \`${task.id}\`: **${task.title}**${deps}`,
      );
      lines.push(`  *Brief:* ${task.brief}`);
    }
    lines.push('');
  }

  lines.push(
    '💡 *Use `/swarm <goal>` to execute this plan across parallel workers with isolated context.*',
  );
  return lines.join('\n');
}

function formatWorkersDisplay(): string {
  return `## 🐝 AFOT Swarm Worker Archetypes & Eco Tool Masking

| Worker Archetype | Pre-Pruned Tools | Max Turns | Token Overhead | Description |
| :--- | :--- | :--- | :--- | :--- |
| **\`researcher\`** | \`web_search\`, \`web_fetch\` | 6 | **~300 tokens** | Online documentation, API specs, and technical research. |
| **\`explorer\`** | \`read_file\`, \`glob\`, \`grep\`, \`ls\` | 8 | **~450 tokens** | Read-only codebase discovery and file structure mapping. |
| **\`coder\`** | \`read_file\`, \`edit\`, \`write_file\` | 10 | **~400 tokens** | Surgical code modification and implementation. |
| **\`verifier\`** | \`shell\`, \`read_file\` | 8 | **~320 tokens** | Test execution, lint verification, and build validation. |

👉 **Token Savings:** Standard monolithic sessions transmit ~10,000–12,000 tokens of tool schemas every turn. AFOT Swarm pre-prunes tools per archetype, achieving **~96% token reduction** per worker turn with 0 context pollution!`;
}

export const swarmCommand: SlashCommand = {
  name: 'swarm',
  altNames: ['orchestrate'],
  description:
    'Plan and execute engineering goals using token-efficient parallel worker swarms',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'plan',
      description:
        'Preview the DAG task breakdown and concurrency waves without executing',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: async (context: CommandContext, args?: string) => {
        const goal = args?.trim();
        if (!goal) {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: 'Please provide a goal: `/swarm plan <goal>`',
          });
          return;
        }

        const agentContext = context.services.agentContext;
        if (!agentContext) {
          coreEvents.emitFeedback('error', 'Agent context not initialized.');
          return;
        }

        coreEvents.emitFeedback('info', 'Planning DAG tasks...');
        const orchestrator = new AfotSwarmOrchestrator(agentContext);
        const plan = await orchestrator.planGoal(goal);
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: formatPlanDisplay(plan),
        });
      },
    },
    {
      name: 'workers',
      description:
        'View specialized worker archetypes, pre-pruned toolsets, and token savings',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) => {
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: formatWorkersDisplay(),
        });
      },
    },
  ],
  action: async (context: CommandContext, rawArgs?: string) => {
    const args = rawArgs?.trim() ?? '';

    if (!args) {
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: `## 🌊 AFOT Parallel Swarm Orchestrator

Execute complex software engineering goals across parallel, token-isolated worker agents.

### Usage:
- \`/swarm <goal>\` — Decompose goal into a DAG and execute concurrently in parallel waves.
- \`/swarm plan <goal>\` — Preview the DAG task breakdown and parallel waves without executing.
- \`/swarm workers\` — View specialized worker archetypes, pre-pruned toolsets, and token savings.

### Examples:
- \`/swarm Research OAuth PKCE and implement token verifier with unit tests\`
- \`/swarm plan Refactor user controller and add vitest coverage\`
- \`/swarm workers\`
`,
      });
      return;
    }

    if (args.startsWith('plan ')) {
      const goal = args.slice(5).trim();
      if (!goal) {
        context.ui.addItem({
          type: MessageType.ERROR,
          text: 'Please specify a goal to plan: `/swarm plan <goal>`',
        });
        return;
      }

      const agentContext = context.services.agentContext;
      if (!agentContext) {
        coreEvents.emitFeedback('error', 'Agent context not initialized.');
        return;
      }

      coreEvents.emitFeedback('info', 'Planning DAG tasks...');
      const orchestrator = new AfotSwarmOrchestrator(agentContext);
      const plan = await orchestrator.planGoal(goal);
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: formatPlanDisplay(plan),
      });
      return;
    }

    if (args === 'workers') {
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: formatWorkersDisplay(),
      });
      return;
    }

    const agentContext = context.services.agentContext;
    if (!agentContext) {
      coreEvents.emitFeedback('error', 'Agent context not initialized.');
      return;
    }

    const goal = args;
    coreEvents.emitFeedback(
      'info',
      `Planning parallel swarm for: "${goal}"...`,
    );

    const orchestrator = new AfotSwarmOrchestrator(agentContext);
    let plan: SwarmPlan;
    try {
      plan = await orchestrator.planGoal(goal);
    } catch (err) {
      debugLogger.error('Failed to plan swarm goal:', err);
      coreEvents.emitFeedback('error', `Swarm planning error: ${err}`);
      return;
    }

    context.ui.addItem({
      type: MessageType.GEMINI,
      text: formatPlanDisplay(plan),
    });

    coreEvents.emitFeedback(
      'info',
      `Launching ${plan.tasks.length} workers across ${plan.waves.length} waves...`,
    );

    try {
      const result = await orchestrator.executeSwarm(plan, (event) => {
        if (event.type === 'wave_start') {
          coreEvents.emitFeedback(
            'info',
            `🌊 Wave ${event.waveIndex}: Executing tasks concurrently...`,
          );
        } else if (event.type === 'task_complete') {
          coreEvents.emitFeedback(
            'info',
            `✅ [${event.worker}] ${event.title} completed (${(
              (event.durationMs ?? 0) / 1000
            ).toFixed(1)}s)`,
          );
        } else if (event.type === 'task_failed') {
          coreEvents.emitFeedback(
            'warning',
            `⚠️ [${event.worker}] ${event.title} failed: ${event.error}`,
          );
        }
      });

      context.ui.addItem({
        type: MessageType.GEMINI,
        text: result.summary,
      });

      coreEvents.emitFeedback(
        'info',
        `Swarm completed in ${(result.totalDurationMs / 1000).toFixed(
          1,
        )}s | ~${result.tokensSavedEstimate.toLocaleString()} tokens saved!`,
      );
    } catch (err) {
      debugLogger.error('Swarm execution error:', err);
      coreEvents.emitFeedback('error', `Swarm execution failed: ${err}`);
    }
  },
};
