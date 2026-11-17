/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  discoverClineAccounts,
  getActiveClineAccount,
  refreshClineAccountToken,
  activateClineAccount,
  setClineModel,
  fetchLiveClineModels,
  type ClineDiscoveredAccount,
  AuthType,
  readAfotConfig,
} from '@google/gemini-cli-core';
import { type CommandContext, CommandKind, type SlashCommand } from './types.js';
import { MessageType } from '../types.js';

function renderClineOverview(activeAccount: ClineDiscoveredAccount | null): string {
  const accounts = discoverClineAccounts();
  const config = readAfotConfig();
  const activeProv = config?.defaultProvider || '(none)';
  const activeModel = config?.defaultModel || '(none)';

  const lines: string[] = [
    '╔════════════════════════════════════════════════════════════════════════════════════╗',
    '║                     AFOT CLINE & KILO CODE BRIDGE DASHBOARD                        ║',
    '╚════════════════════════════════════════════════════════════════════════════════════╝',
    '',
    `  Active Provider: ${activeProv}`,
    `  Active Model:    ${activeModel}`,
    '',
    '──────────────────────────────────────────────────────────────────────────────────────',
    '  DETECTED ACCOUNTS & MODEL HUBS:',
    '──────────────────────────────────────────────────────────────────────────────────────',
  ];

  if (accounts.length === 0) {
    lines.push('  No local Cline or Kilo accounts found in ~/.cline or ~/.cline-account-b.');
  } else {
    for (const a of accounts) {
      const isCurrent = activeProv === a.id || activeProv === a.alias;
      const marker = isCurrent ? '▶ [ACTIVE] ' : '  ';
      const statusStr = a.id === 'kilo'
        ? '(Ready - Direct)'
        : a.isExpired
          ? '⚠ TOKEN EXPIRED (Run: /cline refresh ' + a.alias + ')'
          : '✓ TOKEN ACTIVE';

      lines.push(`${marker}[${a.alias}] ${a.name}`);
      lines.push(`      Email:       ${a.email}`);
      lines.push(`      Status:      ${statusStr}`);
      lines.push(`      Live Model:  ${a.activeModel}`);
      lines.push(`      Token:       ${a.tokenMasked}`);
      lines.push(`      Top Models:  ${a.models.slice(0, 3).join(', ')}`);
      lines.push('');
    }
  }

  lines.push('──────────────────────────────────────────────────────────────────────────────────────');
  lines.push('  DIRECT COMMANDS (No need to use /model):');
  lines.push('──────────────────────────────────────────────────────────────────────────────────────');
  lines.push('  • /cline use gui              Switch to the Cline VS Code GUI account');
  lines.push('  • /cline use cli (or b)       Switch to the Cline CLI account (Account B)');
  lines.push('  • /cline use kilo             Switch to Kilo Code Gateway & Free Models');
  lines.push('  • /cline models [gui|cli]     List all available models for an account');
  lines.push('  • /cline model <model-id>     Directly change model for active Cline session');
  lines.push('  • /cline refresh [gui|cli]    Refresh OAuth access token');
  lines.push('  • /cline sync                 Re-read latest tokens from disk');
  lines.push('──────────────────────────────────────────────────────────────────────────────────────');

  return lines.join('\n');
}

/** /cline status or bare /cline */
const clineOverviewCommand: SlashCommand = {
  name: 'status',
  description: 'Show status and details of connected Cline and Kilo accounts',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context: CommandContext) => {
    const active = getActiveClineAccount();
    context.ui.addItem(
      { type: MessageType.INFO, text: renderClineOverview(active) },
      Date.now(),
    );
  },
};

/** /cline use <account> [model] */
const clineUseCommand: SlashCommand = {
  name: 'use',
  description: 'Switch active account (gui, cli/b, kilo)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context: CommandContext, args: string) => {
    const parts = args.trim().split(/\s+/);
    const target = parts[0];
    const modelOverride = parts[1];

    if (!target) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Usage: /cline use <gui | cli | b | kilo> [model-id]',
        },
        Date.now(),
      );
      return;
    }

    const res = await activateClineAccount(target, modelOverride);
    if (!res.success || !res.account) {
      context.ui.addItem(
        { type: MessageType.ERROR, text: res.message },
        Date.now(),
      );
      return;
    }

    // Refresh auth in the live session
    const config = context.services.agentContext?.config;
    if (config) {
      try {
        await config.refreshAuth(AuthType.AFOT_AUTH);
        const activeModel = modelOverride || res.account.activeModel;
        config.setModel(activeModel, true);
      } catch (err: unknown) {
        context.ui.addItem(
          {
            type: MessageType.WARNING,
            text: `Note: Auth saved. Session warning: ${err instanceof Error ? err.message : String(err)}`,
          },
          Date.now(),
        );
      }
    }

    const lines = [
      res.message,
      '',
      `Account: ${res.account.name} (${res.account.email})`,
      `Active Model: ${modelOverride || res.account.activeModel}`,
      res.account.isExpired && res.account.id !== 'kilo'
        ? '\n⚠ Note: Token is expired. Run "/cline refresh" or open Cline to refresh.'
        : '',
    ];

    context.ui.addItem(
      { type: MessageType.INFO, text: lines.filter(Boolean).join('\n') },
      Date.now(),
    );
  },
};

/** /cline models [account] */
const clineModelsCommand: SlashCommand = {
  name: 'models',
  description: 'List all models for the current or specified Cline account',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext, args: string) => {
    const target = args.trim();
    const accounts = discoverClineAccounts();
    const active = getActiveClineAccount();

    const selectedAccount = target
      ? accounts.find(
          (a) =>
            a.id.toLowerCase() === target.toLowerCase() ||
            a.alias.toLowerCase() === target.toLowerCase() ||
            (target.toLowerCase() === 'b' && a.id === 'cline-cli'),
        )
      : active || accounts[0];

    if (!selectedAccount) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Account "${target}" not found. Run /cline to view detected accounts.`,
        },
        Date.now(),
      );
      return;
    }

    // Try fetching live models from gateway if online
    const liveModels = await fetchLiveClineModels(selectedAccount.token).catch(() => selectedAccount.models);
    const combinedModels = Array.from(new Set([...selectedAccount.models, ...liveModels]));

    const lines: string[] = [
      `Models for ${selectedAccount.name} (${selectedAccount.email}):`,
      `Base URL: ${selectedAccount.baseUrl}`,
      '',
    ];

    for (const m of combinedModels) {
      const isCurrent = m === selectedAccount.activeModel;
      const tag = m.includes(':free') || m.endsWith('-free') ? ' [FREE]' : '';
      lines.push(`${isCurrent ? '▶ ' : '  '}${m}${tag}`);
    }

    lines.push('');
    lines.push('Switch to any model directly with:');
    lines.push(`  /cline model <model-id>`);

    context.ui.addItem(
      { type: MessageType.INFO, text: lines.join('\n') },
      Date.now(),
    );
  },
};

/** /cline model <model-id> */
const clineSetModelCommand: SlashCommand = {
  name: 'model',
  description: 'Directly set active model for this Cline/Kilo connection',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: (context: CommandContext, args: string) => {
    const modelId = args.trim();
    if (!modelId) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Usage: /cline model <model-id>  (e.g. /cline model nvidia/nemotron-3-ultra-550b-a55b:free)',
        },
        Date.now(),
      );
      return;
    }

    const res = setClineModel(modelId);
    if (!res.success) {
      context.ui.addItem(
        { type: MessageType.ERROR, text: res.message },
        Date.now(),
      );
      return;
    }

    const config = context.services.agentContext?.config;
    if (config) {
      config.setModel(modelId, true);
    }

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: `✓ Model switched to "${modelId}". All subsequent prompts in this session will use this model.`,
      },
      Date.now(),
    );
  },
};

/** /cline refresh [account] */
const clineRefreshCommand: SlashCommand = {
  name: 'refresh',
  description: 'Refresh Cline OAuth access token',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext, args: string) => {
    const target = args.trim() || 'cli';
    context.ui.addItem(
      { type: MessageType.INFO, text: `Attempting token refresh for account "${target}"...` },
      Date.now(),
    );

    const res = await refreshClineAccountToken(target);
    if (res.success) {
      context.ui.addItem(
        { type: MessageType.INFO, text: res.message },
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

/** /cline sync */
const clineSyncCommand: SlashCommand = {
  name: 'sync',
  description: 'Re-scan disk for fresh tokens from VS Code and Cline CLI',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context: CommandContext) => {
    const accounts = discoverClineAccounts();
    const lines = [
      `✓ Re-scanned filesystem. Found ${accounts.length} Cline / Kilo configuration(s):`,
      '',
    ];

    for (const a of accounts) {
      lines.push(`• [${a.alias}] ${a.name} -> ${a.email} (${a.tokenMasked})`);
    }

    lines.push('');
    lines.push('Run /cline use <alias> to connect.');

    context.ui.addItem(
      { type: MessageType.INFO, text: lines.join('\n') },
      Date.now(),
    );
  },
};

/** Main /cline command */
export const clineCommand: SlashCommand = {
  name: 'cline',
  description: 'Manage connected Cline & Kilo Code accounts and models directly',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  subCommands: [
    clineOverviewCommand,
    clineUseCommand,
    clineModelsCommand,
    clineSetModelCommand,
    clineRefreshCommand,
    clineSyncCommand,
  ],
  action: (context: CommandContext, args: string) => {
    const sub = args.trim().toLowerCase();
    if (sub === 'gui') {
      return clineUseCommand.action!(context, 'gui');
    }
    if (sub === 'cli' || sub === 'b') {
      return clineUseCommand.action!(context, 'cli');
    }
    if (sub === 'kilo') {
      return clineUseCommand.action!(context, 'kilo');
    }
    return clineOverviewCommand.action!(context, '');
  },
};
