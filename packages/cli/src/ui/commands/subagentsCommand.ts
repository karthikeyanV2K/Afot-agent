/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { coreEvents } from '@google/gemini-cli-core';
import { MessageType } from '../types.js';

export const subagentsCommand: SlashCommand = {
  name: 'subagents',
  altNames: ['subagent', 'workers'],
  description:
    'Switch between subagents, monitor their active tools, and inspect work progress',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'list',
      description: 'List all available subagents and their mounted tools',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) => showSubagentsList(context),
    },
    {
      name: 'switch',
      description:
        'Switch active turn to a specific subagent. Usage: /subagents switch <agent_name> [prompt]',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: async (
        context: CommandContext,
        rawArgs?: string,
      ): Promise<SlashCommandActionReturn | void> => {
        const parts = (rawArgs?.trim() ?? '').split(/\s+/);
        const agentName = parts[0]?.replace(/^@/, '');
        const prompt = parts.slice(1).join(' ');

        if (!agentName) {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: 'Please specify an agent to switch to: `/subagents switch <name> [prompt]`',
          });
          return;
        }

        const config = context.services.agentContext?.config;
        const registry = config?.getAgentRegistry();
        const def = registry?.getDefinition(agentName);

        if (!def) {
          context.ui.addItem({
            type: MessageType.ERROR,
            text: `Subagent "@${agentName}" was not found. Run \`/subagents list\` to view available agents.`,
          });
          return;
        }

        coreEvents.emitFeedback('info', `Switched to subagent @${agentName}`);

        return {
          type: 'submit_prompt',
          content: `@${agentName} ${prompt}`.trim(),
        };
      },
    },
  ],
  action: async (
    context: CommandContext,
    rawArgs?: string,
  ): Promise<SlashCommandActionReturn | void> => {
    const args = rawArgs?.trim() ?? '';

    if (args.startsWith('switch ')) {
      const rest = args.slice(7).trim();
      const parts = rest.split(/\s+/);
      const agentName = parts[0]?.replace(/^@/, '');
      const prompt = parts.slice(1).join(' ');

      if (!agentName) {
        context.ui.addItem({
          type: MessageType.ERROR,
          text: 'Usage: `/subagents switch <agent-name> [prompt]`',
        });
        return;
      }

      return {
        type: 'submit_prompt',
        content: `@${agentName} ${prompt}`.trim(),
      };
    }

    await showSubagentsList(context);
  },
};

async function showSubagentsList(context: CommandContext): Promise<void> {
  const config = context.services.agentContext?.config;
  const registry = config?.getAgentRegistry();

  if (!registry) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Agent registry not loaded.',
    });
    return;
  }

  const allDefs = registry.getAllDefinitions();
  const currentApprovalMode = config?.getApprovalMode() ?? 'default';

  const lines: string[] = [
    `## 🐝 AFOT Subagent Workspace & Switcher`,
    `**Active Approval Mode:** \`${currentApprovalMode.toUpperCase()}\` (Use \`/approver\` to toggle)`,
    '',
    `### ⚡ How to Switch & Invoke Subagents:`,
    `- Type \`@\` in any prompt to bring up interactive agent autocomplete.`,
    `- Or run: \`/subagents switch <agent_name> <your prompt>\``,
    `- Or run multi-agent parallel swarms: \`/swarm <goal>\``,
    '',
    `### 📋 Available Subagents:`,
  ];

  for (const def of allDefs) {
    const isSwarm = def.name.startsWith('swarm_');
    const badge = isSwarm ? '⚡ **[Swarm Worker]**' : '🤖 **[Core Subagent]**';
    const toolList =
      def.kind === 'local' && def.toolConfig?.tools
        ? def.toolConfig.tools
            .map((t) => (typeof t === 'string' ? t : t.name))
            .join(', ')
        : 'All Tools';

    lines.push(
      `- ${badge} **\`@${def.name}\`** — *${def.displayName ?? def.name}*`,
    );
    lines.push(`  - **Role:** ${def.description.split('.')[0]}.`);
    lines.push(`  - **Tools Mounted:** \`${toolList}\``);
    lines.push(
      `  - **Switch Command:** \`/subagents switch ${def.name} <prompt>\``,
    );
    lines.push('');
  }

  context.ui.addItem({
    type: MessageType.GEMINI,
    text: lines.join('\n'),
  });
}
