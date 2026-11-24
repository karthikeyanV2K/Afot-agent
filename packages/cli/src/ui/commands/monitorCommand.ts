/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import {
  getAfotMonitorMode,
  setAfotMonitorMode,
  setAfotMonitorRuntime,
  type AfotMonitorMode,
} from '@google/gemini-cli-core';

const MODES: readonly AfotMonitorMode[] = ['off', 'compact', 'expanded'];

function info(content: string): SlashCommandActionReturn {
  return { type: 'message', messageType: 'info', content };
}

export const monitorCommand: SlashCommand = {
  name: 'monitor',
  description:
    'Live timeline of steps, commands and requests: /monitor [off|compact|expanded|status]',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (_context, args): SlashCommandActionReturn => {
    const arg = args.trim().toLowerCase();
    if (arg === '' || arg === 'status') {
      return info(
        `Monitor: ${getAfotMonitorMode()}. Use /monitor off|compact|expanded.`,
      );
    }
    const mode = MODES.find((m) => m === arg);
    if (!mode) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Usage: /monitor [off|compact|expanded|status]',
      };
    }
    try {
      setAfotMonitorMode(mode);
    } catch (e) {
      setAfotMonitorRuntime(mode);
      return info(
        `Monitor: ${mode} (this session only; could not save: ${e instanceof Error ? e.message : String(e)})`,
      );
    }
    return info(`Monitor: ${mode} (saved).`);
  },
};
