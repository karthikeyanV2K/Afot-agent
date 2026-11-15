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
  EDIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../tools/tool-names.js';

export const SwarmCoderReportSchema = z.object({
  summary: z
    .string()
    .describe('A concise summary of code modifications performed.'),
  modifiedFiles: z
    .array(z.string())
    .describe('List of files modified or created during the task.'),
});

/**
 * Surgical code modification worker. Reads target files and performs clean edits or writes new code.
 * Toolset pre-pruned to read_file, edit, and write_file (saving ~9,000 tokens of schema overhead).
 */
export const SwarmCoderAgent = (
  _contextOrConfig: Config | AgentLoopContext,
): LocalAgentDefinition<typeof SwarmCoderReportSchema> => ({
  name: 'swarm_coder',
  kind: 'local',
  displayName: 'Swarm Coder',
  description:
    'Targeted code authoring and editing worker. Reads and edits specific files with surgical precision.',
  inputConfig: {
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The code implementation or modification task.',
        },
        context: {
          type: 'string',
          description:
            'Upstream exploration findings, file locations, or specifications.',
        },
      },
      required: ['task'],
    },
  },
  outputConfig: {
    outputName: 'report',
    description: 'Summary of code modifications and affected files.',
    schema: SwarmCoderReportSchema,
  },
  processOutput: (output) => {
    if (!output) return 'No code modifications reported.';
    const files = (output.modifiedFiles ?? [])
      .map((f) => `- \`${f}\``)
      .join('\n');
    return `### Code Modifications\n${output.summary}\n\n**Files Modified:**\n${files || '- None'}`;
  },
  modelConfig: {
    model: 'inherit',
  },
  runConfig: {
    maxTimeMinutes: 8,
    maxTurns: 10,
  },
  toolConfig: {
    tools: [READ_FILE_TOOL_NAME, EDIT_TOOL_NAME, WRITE_FILE_TOOL_NAME],
  },
  includeExtensionContext: false,
  promptConfig: {
    systemPrompt: `You are Swarm Coder, a precision code implementation agent.
Your mission is to implement code changes cleanly, reliably, and accurately.
Directives:
1. First read the target files using read_file to inspect line numbers, formatting, and surrounding context.
2. Use edit for targeted replacements. Use write_file only for creating brand new files or full rewrites.
3. Adhere strictly to existing codebase conventions, naming styles, and TypeScript types.
4. When done, immediately call complete_task with your summary and list of modified files.`,
    query: `Execute coding task:
\${task}

Context:
\${context}`,
  },
});
