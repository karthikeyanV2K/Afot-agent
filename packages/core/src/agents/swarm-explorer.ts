/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { LocalAgentDefinition } from './types.js';
import type { Config } from '../config/config.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
} from '../tools/tool-names.js';

export const SwarmExplorerReportSchema = z.object({
  summary: z
    .string()
    .describe(
      'A concise architectural summary and analysis of codebase findings.',
    ),
  relevantFiles: z
    .array(z.string())
    .describe('List of relevant file paths discovered during exploration.'),
  keyFindings: z
    .string()
    .optional()
    .describe(
      'Key function signatures, data types, interfaces, or line references.',
    ),
});

/**
 * High-speed codebase explorer for architectural discovery and file mapping.
 * Toolset pre-pruned to read-only navigation tools (saving ~9,000 tokens of schema overhead).
 */
export const SwarmExplorerAgent = (
  _contextOrConfig: Config | AgentLoopContext,
): LocalAgentDefinition<typeof SwarmExplorerReportSchema> => ({
  name: 'swarm_explorer',
  kind: 'local',
  displayName: 'Swarm Explorer',
  description:
    'Fast read-only codebase explorer. Discovers files, locates symbols, and inspects imports/architecture without modifying code.',
  inputConfig: {
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The exploration or codebase investigation assignment.',
        },
        context: {
          type: 'string',
          description: 'Optional upstream context or background requirements.',
        },
      },
      required: ['task'],
    },
  },
  outputConfig: {
    outputName: 'report',
    description: 'The exploration report with file paths and architecture.',
    schema: SwarmExplorerReportSchema,
  },
  processOutput: (output) => {
    if (!output) return 'No exploration findings returned.';
    const files = (output.relevantFiles ?? [])
      .map((f) => `- \`${f}\``)
      .join('\n');
    return `### Exploration Summary\n${output.summary}\n\n**Relevant Files:**\n${files || '- None'}${output.keyFindings ? `\n\n**Key Findings:**\n${output.keyFindings}` : ''}`;
  },
  modelConfig: {
    model: 'inherit',
  },
  runConfig: {
    maxTimeMinutes: 5,
    maxTurns: 8,
  },
  toolConfig: {
    tools: [READ_FILE_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME, LS_TOOL_NAME],
  },
  includeExtensionContext: false,
  promptConfig: {
    systemPrompt: `You are Swarm Explorer, a lightning-fast codebase inspection agent.
Your goal is to inspect the project to locate relevant files, types, and logic for the assigned task.
Directives:
1. Use glob and grep to locate relevant files quickly.
2. Read only the relevant portions of files using read_file.
3. DO NOT attempt to edit or modify files (you are strictly read-only).
4. As soon as you understand the code structure, call complete_task with your findings. Keep it dense and actionable.`,
    query: `Execute exploration task:
\${task}

Context:
\${context}`,
  },
});
