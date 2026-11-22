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
  AfotSwarmManager,
  AfotSwarmOrchestrator,
  coreEvents,
  debugLogger,
  type SwarmBoardPost,
  type SwarmPlan,
  type SwarmRosterStatus,
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

| Worker Archetype | Pre-Pruned Tools | Max Turns | Approx. Token Overhead | Description |
| :--- | :--- | :--- | :--- | :--- |
| **\`researcher\`** | \`web_search\`, \`web_fetch\` | 6 | **~300 tokens** | Online documentation, API specs, and technical research. |
| **\`explorer\`** | \`read_file\`, \`glob\`, \`grep\`, \`ls\` | 8 | **~450 tokens** | Read-only codebase discovery and file structure mapping. |
| **\`coder\`** | \`read_file\`, \`edit\`, \`write_file\` | 10 | **~400 tokens** | Surgical code modification and implementation. |
| **\`verifier\`** | \`shell\`, \`read_file\` | 8 | **~320 tokens** | Test execution, lint verification, and build validation. |

👉 **Token Savings:** Standard monolithic sessions transmit roughly 10,000–12,000 tokens of tool schemas every turn. AFOT Swarm pre-prunes tools per archetype, which substantially reduces the tool-schema tokens sent per worker turn (the exact saving depends on your provider and model).`;
}

function formatRosterStatusDisplay(status: SwarmRosterStatus): string {
  const lines: string[] = [
    `## 🐝 AFOT Swarm Worker Roster — "${status.title}"`,
    '',
    `| Worker Name | Archetype | State | Model | Brief / Current Assignment |`,
    `| :--- | :--- | :--- | :--- | :--- |`,
  ];

  for (const m of status.members) {
    const stateBadge =
      m.state === 'working'
        ? '🟡 **WORKING**'
        : m.state === 'waiting'
          ? '🟢 WAITING'
          : m.state === 'killed'
            ? '🔴 KILLED'
            : '⚪ STOPPED';
    lines.push(
      `| **@${m.name}** | \`${m.role}\` | ${stateBadge} | \`${m.model || 'inherit'}\` | ${m.brief} |`,
    );
  }

  lines.push('');
  lines.push(`**Total Board Messages:** ${status.totalPosts}`);
  lines.push(
    '💡 *Use `/swarm board` to read messages or `/swarm post @<worker> <msg>` to assign tasks.*',
  );
  return lines.join('\n');
}

function formatBoardDisplay(posts: SwarmBoardPost[], title: string): string {
  if (posts.length === 0) {
    return `## 📋 AFOT Swarm Message Board — "${title}"\n\n*(The message board is currently empty. Use \`/swarm post @<worker> <message>\` to post)*`;
  }

  const lines: string[] = [
    `## 📋 AFOT Swarm Message Board — "${title}"`,
    '',
  ];

  for (const p of posts) {
    const recipient = p.recipient ? ` ➔ **@${p.recipient}**` : '';
    const timeStr = new Date(p.timestamp).toLocaleTimeString();
    lines.push(
      `**#${p.seq}** \`[${timeStr}]\` **@${p.sender}**${recipient}:\n> ${p.text.split('\n').join('\n> ')}\n`,
    );
  }

  lines.push(
    '💡 *Post an assignment or feedback with `/swarm post @<worker> <message>`*',
  );
  return lines.join('\n');
}

function formatSwarmDashboard(
  status: SwarmRosterStatus,
  activeModel?: string,
): string {
  const memberRows = status.members
    .map((m) => {
      const stateBadge =
        m.state === 'working'
          ? 'WORKING'
          : m.state === 'waiting'
            ? 'WAITING'
            : m.state === 'killed'
              ? 'KILLED'
              : 'STOPPED';
      return `  • @${m.name.padEnd(12)} [${m.role.padEnd(10)}] State: ${stateBadge.padEnd(8)} | Model: ${m.model || 'inherit'}\n    Assignment: ${m.brief}`;
    })
    .join('\n');

  const recentPosts =
    status.recentPosts.length > 0
      ? status.recentPosts
          .slice(-6)
          .map((p) => {
            const recipient = p.recipient ? ` ➔ @${p.recipient}` : '';
            return `  #${p.seq} @${p.sender}${recipient}: ${p.text.slice(0, 100)}`;
          })
          .join('\n')
      : '  (No posts on the board yet)';

  return `╔══════════════════════════════════════════════════════════════════════════════╗
║                     AFOT SWARM COORDINATOR & MESSAGE BOARD                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
Title: "${status.title}" | Active Workers: ${status.members.filter((m) => m.state !== 'killed').length} | Board Posts: ${status.totalPosts}
Active Model: ${activeModel || 'default'}

────────────────────────────────────────────────────────────────────────────────
  WORKER ROSTER:
────────────────────────────────────────────────────────────────────────────────
${memberRows || '  (No workers registered yet)'}

────────────────────────────────────────────────────────────────────────────────
  RECENT MESSAGE BOARD ACTIVITY:
────────────────────────────────────────────────────────────────────────────────
${recentPosts}

────────────────────────────────────────────────────────────────────────────────
  AGY CLI SWARM COMMANDS:
────────────────────────────────────────────────────────────────────────────────
  • /swarm status                 Show live roster & worker states (waiting/working/stopped/killed)
  • /swarm board [since]          Read posts from the shared message board
  • /swarm post @<worker> <msg>   Post assignment or feedback to the message board
  • /swarm add <name> <brief>     Spawn a new worker under <name> with assignment
  • /swarm kill <name>            Permanently terminate a worker
  • /swarm model <name> <model>   Switch worker to a different model
  • /swarm models                 List available models for workers
  • /swarm title <name>           Set the swarm session title
  • /swarm <goal> (or run <goal>) Decompose & execute goal across parallel workers
  • /swarm plan <goal>            Preview DAG task waves without executing
  • /swarm workers                View worker archetypes & token efficiency
  • /swarm reset                  Reset swarm roster & message board
`;
}

export const swarmCommand: SlashCommand = {
  name: 'swarm',
  altNames: ['orchestrate'],
  description:
    'Plan and execute engineering goals using token-efficient parallel worker swarms (AGY-compatible)',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  subCommands: [
    {
      name: 'status',
      description: 'Show live worker roster and states (waiting, working, stopped, killed)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) => {
        const manager = AfotSwarmManager.getInstance();
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: formatRosterStatusDisplay(manager.getStatus()),
        });
      },
    },
    {
      name: 'board',
      description: 'Read recent messages from the shared swarm message board',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext, args?: string) => {
        const manager = AfotSwarmManager.getInstance();
        const sinceSeq = args?.trim() ? parseInt(args.trim(), 10) || 0 : 0;
        const posts = manager.readBoard(sinceSeq);
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: formatBoardDisplay(posts, manager.getTitle()),
        });
      },
    },
    {
      name: 'post',
      description: 'Post an assignment or feedback to the swarm board: /swarm post @<worker> <message>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: async (context: CommandContext, rawArgs?: string) => {
        const text = rawArgs?.trim();
        if (!text) {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: 'Please specify a message: `/swarm post @<worker> <message>`',
          });
          return;
        }

        const manager = AfotSwarmManager.getInstance();
        const match = text.match(/^@([a-zA-Z0-9_-]+)\s+(.*)$/);
        const recipient = match ? match[1] : undefined;
        const postText = match ? match[2] : text;

        const post = manager.postMessage('coordinator', postText, recipient);
        coreEvents.emitFeedback(
          'info',
          `Posted #${post.seq} to board ${recipient ? `➔ @${recipient}` : ''}`,
        );
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: `✅ **Posted to Board (#${post.seq})**:\n> **@coordinator**${recipient ? ` ➔ **@${recipient}**` : ''}: ${post.text}`,
        });
      },
    },
    {
      name: 'add',
      description: 'Spawn a new worker under <name> with assignment: /swarm add <name> <brief>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: async (context: CommandContext, rawArgs?: string) => {
        const parts = (rawArgs?.trim() ?? '').split(/\s+/);
        const name = parts[0]?.replace(/^@/, '');
        const brief = parts.slice(1).join(' ');

        if (!name || !brief) {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: 'Usage: `/swarm add <worker-name> <brief / assignment>`',
          });
          return;
        }

        const manager = AfotSwarmManager.getInstance();
        const member = manager.addWorker(name, brief);
        coreEvents.emitFeedback('info', `Added worker @${member.name} to swarm`);
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: `🐝 **Worker Added to Swarm Roster**:\n- **Name:** \`@${member.name}\`\n- **Role:** \`${member.role}\`\n- **State:** \`${member.state}\`\n- **Assignment:** ${member.brief}\n\n*Posted to message board as assignment.*`,
        });
      },
    },
    {
      name: 'kill',
      description: 'Permanently terminate a worker: /swarm kill <name>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: async (context: CommandContext, rawArgs?: string) => {
        const name = rawArgs?.trim().replace(/^@/, '');
        if (!name) {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: 'Usage: `/swarm kill <worker-name>`',
          });
          return;
        }

        const manager = AfotSwarmManager.getInstance();
        const success = manager.killWorker(name);
        if (success) {
          coreEvents.emitFeedback('info', `Worker @${name} terminated.`);
          context.ui.addItem({
            type: MessageType.GEMINI,
            text: `🛑 **Worker @${name} has been terminated.**`,
          });
        } else {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: `Worker @${name} was not found or cannot be killed.`,
          });
        }
      },
    },
    {
      name: 'model',
      description: 'Switch a worker to another model: /swarm model <name> <model>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: async (context: CommandContext, rawArgs?: string) => {
        const parts = (rawArgs?.trim() ?? '').split(/\s+/);
        const name = parts[0]?.replace(/^@/, '');
        const model = parts.slice(1).join(' ');

        if (!name || !model) {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: 'Usage: `/swarm model <worker-name> <model-id>`',
          });
          return;
        }

        const manager = AfotSwarmManager.getInstance();
        const success = manager.setWorkerModel(name, model);
        if (success) {
          coreEvents.emitFeedback('info', `Switched @${name} model to ${model}`);
          context.ui.addItem({
            type: MessageType.GEMINI,
            text: `🔄 **Worker @${name} model updated to \`${model}\`.**`,
          });
        } else {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: `Worker @${name} was not found.`,
          });
        }
      },
    },
    {
      name: 'models',
      description: 'List available models for swarm workers',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) => {
        const activeModel =
          context.services.agentContext?.config.getActiveModel() ?? 'default';
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: `## 🤖 Swarm Worker Models\n\n- **Active Session Model:** \`${activeModel}\`\n- **Inherit (Default):** Workers inherit the current active model.\n- **Custom Models:** Any provider model can be pinned per worker (e.g. \`/swarm model coder deepseek/deepseek-v4-flash\`).`,
        });
      },
    },
    {
      name: 'title',
      description: 'Name or rename the swarm session: /swarm title <name>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: async (context: CommandContext, rawArgs?: string) => {
        const title = rawArgs?.trim();
        if (!title) {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: 'Usage: `/swarm title <session-title>`',
          });
          return;
        }

        const manager = AfotSwarmManager.getInstance();
        manager.setTitle(title);
        coreEvents.emitFeedback('info', `Swarm title set to "${title}"`);
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: `🏷️ **Swarm session titled:** "${title}"`,
        });
      },
    },
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
      name: 'run',
      description: 'Decompose and execute goal across parallel workers: /swarm run <goal>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: async (context: CommandContext, args?: string) => {
        const goal = args?.trim();
        if (!goal) {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: 'Please provide a goal: `/swarm run <goal>`',
          });
          return;
        }
        await executeSwarmGoal(context, goal);
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
    {
      name: 'reset',
      description: 'Reset swarm roster and clear the message board',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) => {
        const manager = AfotSwarmManager.getInstance();
        manager.reset();
        coreEvents.emitFeedback('info', 'Swarm reset successfully.');
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: '🔄 **Swarm roster and message board have been reset.**',
        });
      },
    },
  ],
  action: async (context: CommandContext, rawArgs?: string) => {
    const args = rawArgs?.trim() ?? '';

    if (!args) {
      const manager = AfotSwarmManager.getInstance();
      const activeModel = context.services.agentContext?.config.getActiveModel();
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: formatSwarmDashboard(manager.getStatus(), activeModel),
      });
      return;
    }

    if (args === 'status') {
      const manager = AfotSwarmManager.getInstance();
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: formatRosterStatusDisplay(manager.getStatus()),
      });
      return;
    }

    if (args === 'board' || args.startsWith('board ')) {
      const manager = AfotSwarmManager.getInstance();
      const rest = args.slice(5).trim();
      const sinceSeq = rest ? parseInt(rest, 10) || 0 : 0;
      const posts = manager.readBoard(sinceSeq);
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: formatBoardDisplay(posts, manager.getTitle()),
      });
      return;
    }

    if (args.startsWith('post ')) {
      const text = args.slice(5).trim();
      const manager = AfotSwarmManager.getInstance();
      const match = text.match(/^@([a-zA-Z0-9_-]+)\s+(.*)$/);
      const recipient = match ? match[1] : undefined;
      const postText = match ? match[2] : text;

      const post = manager.postMessage('coordinator', postText, recipient);
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: `✅ **Posted to Board (#${post.seq})**:\n> **@coordinator**${recipient ? ` ➔ **@${recipient}**` : ''}: ${post.text}`,
      });
      return;
    }

    if (args.startsWith('add ')) {
      const parts = args.slice(4).trim().split(/\s+/);
      const name = parts[0]?.replace(/^@/, '');
      const brief = parts.slice(1).join(' ');
      if (!name || !brief) {
        context.ui.addItem({
          type: MessageType.ERROR,
          text: 'Usage: `/swarm add <worker-name> <brief / assignment>`',
        });
        return;
      }
      const manager = AfotSwarmManager.getInstance();
      const member = manager.addWorker(name, brief);
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: `🐝 **Worker Added to Swarm Roster**:\n- **Name:** \`@${member.name}\`\n- **Role:** \`${member.role}\`\n- **State:** \`${member.state}\`\n- **Assignment:** ${member.brief}`,
      });
      return;
    }

    if (args.startsWith('kill ')) {
      const name = args.slice(5).trim().replace(/^@/, '');
      const manager = AfotSwarmManager.getInstance();
      const success = manager.killWorker(name);
      if (success) {
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: `🛑 **Worker @${name} has been terminated.**`,
        });
      } else {
        context.ui.addItem({
          type: MessageType.ERROR,
          text: `Worker @${name} was not found or cannot be killed.`,
        });
      }
      return;
    }

    if (args.startsWith('model ')) {
      const parts = args.slice(6).trim().split(/\s+/);
      const name = parts[0]?.replace(/^@/, '');
      const model = parts.slice(1).join(' ');
      const manager = AfotSwarmManager.getInstance();
      const success = manager.setWorkerModel(name, model);
      if (success) {
        context.ui.addItem({
          type: MessageType.GEMINI,
          text: `🔄 **Worker @${name} model updated to \`${model}\`.**`,
        });
      } else {
        context.ui.addItem({
          type: MessageType.ERROR,
          text: `Worker @${name} was not found.`,
        });
      }
      return;
    }

    if (args === 'models') {
      const activeModel =
        context.services.agentContext?.config.getActiveModel() ?? 'default';
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: `## 🤖 Swarm Worker Models\n\n- **Active Session Model:** \`${activeModel}\`\n- **Inherit (Default):** Workers inherit the current active model.\n- **Custom Models:** Any provider model can be pinned per worker (e.g. \`/swarm model coder deepseek/deepseek-v4-flash\`).`,
      });
      return;
    }

    if (args.startsWith('title ')) {
      const title = args.slice(6).trim();
      const manager = AfotSwarmManager.getInstance();
      manager.setTitle(title);
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: `🏷️ **Swarm session titled:** "${title}"`,
      });
      return;
    }

    if (args === 'reset') {
      const manager = AfotSwarmManager.getInstance();
      manager.reset();
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: '🔄 **Swarm roster and message board have been reset.**',
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

    const goal = args.startsWith('run ') ? args.slice(4).trim() : args;
    await executeSwarmGoal(context, goal);
  },
};

async function executeSwarmGoal(
  context: CommandContext,
  goal: string,
): Promise<void> {
  const agentContext = context.services.agentContext;
  if (!agentContext) {
    coreEvents.emitFeedback('error', 'Agent context not initialized.');
    return;
  }

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
      )}s | ~${result.tokensSavedEstimate.toLocaleString()} tokens saved (rough estimate)`,
    );
  } catch (err) {
    debugLogger.error('Swarm execution error:', err);
    coreEvents.emitFeedback('error', `Swarm execution failed: ${err}`);
  }
}
