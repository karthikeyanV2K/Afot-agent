/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import {
  getAgentDockState,
  setAgentDock,
  toggleAgentDock,
  toggleAgentDockView,
} from '../components/dock/agentDockStore.js';

function info(content: string): SlashCommandActionReturn {
  return { type: 'message', messageType: 'info', content };
}

function error(content: string): SlashCommandActionReturn {
  return { type: 'message', messageType: 'error', content };
}

function describeState(): string {
  const state = getAgentDockState();
  const where =
    state.view === 'split' ? 'split view' : `single view (${state.pane})`;
  return `Agent dock ${state.open ? 'open' : 'closed'} · ${where}.`;
}

export const dockCommand: SlashCommand = {
  name: 'dock',
  altNames: ['agents-dock'],
  description:
    'Agent dock under the prompt: /dock [open|close|toggle|single|split|subagents|swarm|status]',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (_context, args): SlashCommandActionReturn => {
    const arg = args.trim().toLowerCase();
    switch (arg) {
      case '':
      case 'toggle':
        toggleAgentDock();
        break;
      case 'open':
        setAgentDock({ open: true });
        break;
      case 'close':
        setAgentDock({ open: false });
        break;
      case 'single':
        setAgentDock({ open: true, view: 'single' });
        break;
      case 'split':
        setAgentDock({ open: true, view: 'split' });
        break;
      case 'subagents':
        setAgentDock({ open: true, view: 'single', pane: 'subagents' });
        break;
      case 'swarm':
        setAgentDock({ open: true, view: 'single', pane: 'swarm' });
        break;
      case 'view':
        toggleAgentDockView();
        break;
      case 'status':
        break;
      default:
        return error(
          `Unknown dock option "${arg}". Use open, close, toggle, single, split, subagents, swarm, view or status.`,
        );
    }
    return info(describeState());
  },
};
