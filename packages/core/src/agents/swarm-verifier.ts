/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { LocalAgentDefinition } from './types.js';
import type { Config } from '../config/config.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { READ_FILE_TOOL_NAME, SHELL_TOOL_NAME } from '../tools/tool-names.js';

export const SwarmVerifierReportSchema = z.object({
  success: z
    .boolean()
    .describe('Whether all verification checks and tests passed successfully.'),
  summary: z
    .string()
    .describe('Summary of verification results, tests run, or errors found.'),
  commandOutputs: z
    .string()
    .optional()
    .describe('Pertinent command output snippet or failure trace.'),
});

/**
 * Automated test and verification worker. Executes tests, linters, and build commands.
 * Toolset pre-pruned to shell and read_file (saving ~9,500 tokens of schema overhead).
 */
export const SwarmVerifierAgent = (
  _contextOrConfig: Config | AgentLoopContext,
): LocalAgentDefinition<typeof SwarmVerifierReportSchema> => ({
  name: 'swarm_verifier',
  kind: 'local',
  displayName: 'Swarm Verifier',
  description:
    'Automated test and verification worker. Runs shell commands (tests, builds, linters) and checks results.',
  inputConfig: {
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The test or verification task (e.g. test paths, build targets).',
        },
        context: {
          type: 'string',
          description: 'Context regarding modified files or expected results.',
        },
      },
      required: ['task'],
    },
  },
  outputConfig: {
    outputName: 'report',
    description: 'The verification status and test outputs.',
    schema: SwarmVerifierReportSchema,
  },
  processOutput: (output) => {
    if (!output) return 'No verification output returned.';
    const status = output.success ? '✅ PASSED' : '❌ FAILED';
    return `### Verification: ${status}\n${output.summary}${
      output.commandOutputs
        ? `\n\n\`\`\`\n${output.commandOutputs.trim()}\n\`\`\``
        : ''
    }`;
  },
  modelConfig: {
    model: 'inherit',
  },
  runConfig: {
    maxTimeMinutes: 6,
    maxTurns: 8,
  },
  toolConfig: {
    tools: [SHELL_TOOL_NAME, READ_FILE_TOOL_NAME],
  },
  includeExtensionContext: false,
  promptConfig: {
    systemPrompt: `You are Swarm Verifier, an automated quality and test verification agent.
Your mission is to run tests, linters, or build commands to ensure system health and catch regressions.
Directives:
1. Run targeted, fast tests first (e.g. specific test files instead of full test suites).
2. If tests fail, diagnose the root cause concisely.
3. Call complete_task with your pass/fail verdict, summary, and error output if any.`,
    query: `Execute verification task:
\${task}

Context:
\${context}`,
  },
});
