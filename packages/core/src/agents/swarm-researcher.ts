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
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
} from '../tools/tool-names.js';

export const SwarmResearcherReportSchema = z.object({
  summary: z
    .string()
    .describe(
      'A concise, highly factual technical summary of findings answering the research objective.',
    ),
  sources: z
    .array(z.string())
    .optional()
    .describe('Key documentation URLs, API references, or sources consulted.'),
});

/**
 * Hyper-efficient web search and external technical documentation researcher.
 * Toolset pre-pruned to web_search and web_fetch (saving ~9,500 tokens of schema overhead).
 */
export const SwarmResearcherAgent = (
  _contextOrConfig: Config | AgentLoopContext,
): LocalAgentDefinition<typeof SwarmResearcherReportSchema> => ({
  name: 'swarm_researcher',
  kind: 'local',
  displayName: 'Swarm Researcher',
  description:
    'Ultra-efficient web and documentation research worker. Searches web, extracts technical documentation, and returns distilled findings without bloating context.',
  inputConfig: {
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The specific technical query or documentation to research.',
        },
        context: {
          type: 'string',
          description: 'Optional background context or prior findings.',
        },
      },
      required: ['task'],
    },
  },
  outputConfig: {
    outputName: 'report',
    description: 'The research report with findings and sources.',
    schema: SwarmResearcherReportSchema,
  },
  processOutput: (output) => {
    if (!output) return 'No research findings returned.';
    const summary = output.summary?.trim() ?? '';
    const sources = (output.sources ?? []).filter((s) => Boolean(s?.trim()));
    if (sources.length > 0) {
      return `${summary}\n\n**Sources:**\n${sources.map((s) => `- ${s}`).join('\n')}`;
    }
    return summary;
  },
  modelConfig: {
    model: 'inherit',
  },
  runConfig: {
    maxTimeMinutes: 5,
    maxTurns: 6,
  },
  toolConfig: {
    tools: [WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME],
  },
  includeExtensionContext: false,
  promptConfig: {
    systemPrompt: `You are Swarm Researcher, an elite, hyper-focused technical research agent.
Your mission is to find factual, up-to-date documentation, API specs, and technical solutions on the web.
Directives:
1. Use web_search for pinpoint queries.
2. Use web_fetch when you need in-depth content from a specific documentation page or repository.
3. Be strictly factual and concise. Extract only what is necessary to answer the task.
4. When you have the required information, immediately call complete_task with your structured findings. Do not ramble.`,
    query: `Execute research task:
\${task}

Context:
\${context}`,
  },
});
