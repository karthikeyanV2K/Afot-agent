/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  discoverClineAccounts,
  activateClineAccount,
  setClineModel,
  AuthType,
} from '@google/gemini-cli-core';
import { type CommandContext, CommandKind, type SlashCommand } from './types.js';
import { MessageType } from '../types.js';

export const kiloCommand: SlashCommand = {
  name: 'kilo',
  description: 'Access Kilo Code AI Gateway and free models directly',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext, args: string) => {
    const trimmed = args.trim();
    const accounts = discoverClineAccounts();
    const kiloAccount = accounts.find((a) => a.id === 'kilo');

    if (!kiloAccount) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Kilo Code configuration not found on disk (~/.config/kilo or ~/.cache/kilo).',
        },
        Date.now(),
      );
      return;
    }

    if (trimmed.startsWith('model ')) {
      const modelId = trimmed.replace(/^model\s+/, '').trim();
      const res = setClineModel(modelId);
      if (res.success) {
        const config = context.services.agentContext?.config;
        if (config) config.setModel(modelId, true);
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `✓ Kilo Code model switched to: "${modelId}"`,
          },
          Date.now(),
        );
      } else {
        context.ui.addItem(
          { type: MessageType.ERROR, text: res.message },
          Date.now(),
        );
      }
      return;
    }

    // Default action: activate Kilo Code provider
    const res = await activateClineAccount('kilo');
    if (res.success && res.account) {
      const config = context.services.agentContext?.config;
      if (config) {
        try {
          await config.refreshAuth(AuthType.AFOT_AUTH);
          config.setModel(res.account.activeModel, true);
        } catch {}
      }

      const lines = [
        '╔════════════════════════════════════════════════════════════════════════════════════╗',
        '║                           KILO CODE AI GATEWAY CONNECTED                           ║',
        '╚════════════════════════════════════════════════════════════════════════════════════╝',
        '',
        `  Status:       Active Gateway (${kiloAccount.baseUrl})`,
        `  Active Model: ${res.account.activeModel}`,
        '',
        '  Available Free Models:',
      ];

      for (const m of kiloAccount.models.slice(0, 10)) {
        lines.push(`  • ${m}`);
      }

      lines.push('');
      lines.push('  Switch models anytime with:');
      lines.push('  • /kilo model <model-id>');
      lines.push('  • /cline model <model-id>');

      context.ui.addItem(
        { type: MessageType.INFO, text: lines.join('\n') },
        Date.now(),
      );
    } else {
      context.ui.addItem(
        { type: MessageType.ERROR, text: res.message },
        Date.now(),
      );
    }
  },
};
