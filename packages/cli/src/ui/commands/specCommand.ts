/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { generateHeuristicPlan, shortenTitle } from '@google/gemini-cli-core';

function info(content: string): SlashCommandActionReturn {
  return { type: 'message', messageType: 'info', content };
}

export const specCommand: SlashCommand = {
  name: 'spec',
  altNames: ['plan', 'spec-timeline'],
  description:
    'Generate and track a spec timeline: /spec "rewrite to rust" | /spec confirm | /spec cancel | /spec status',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context, args): SlashCommandActionReturn => {
    const arg = args.trim();
    
    if (!arg || arg === 'status') {
      // TODO: Return current spec state from UI
      return info('Spec timeline: use /spec "your goal" to create a new spec');
    }
    
    if (arg === 'confirm') {
      return info('Spec confirmed - TODO: wire to UI');
    }
    
    if (arg === 'cancel') {
      return info('Spec cancelled - TODO: wire to UI');
    }
    
    // Generate plan from goal
    const plan = generateHeuristicPlan(arg);
    return info(
      `Generated spec: "${shortenTitle(plan.title ?? arg)}"\n` +
      `Tasks: ${plan.tasks.length} | Waves: ${plan.waves.length}\n` +
      `Run /spec confirm to start tracking, or /spec cancel to discard.`
    );
  },
};