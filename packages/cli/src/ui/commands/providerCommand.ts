/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getAllAfotProviderStatus,
  setAfotDefaultProvider,
  setAfotProviderKey,
  resolveAfotProvider,
  resolveAfotActiveProviderName,
  resolveAfotProviderByName,
  fetchAfotProviderModels,
  resolveOpenCodeProvider,
  readAfotConfig,
} from '@google/gemini-cli-core';
import { type CommandContext, CommandKind, type SlashCommand } from './types.js';
import { MessageType } from '../types.js';
import { AuthType } from '@google/gemini-cli-core';

/** /provider list */
const providerListCommand: SlashCommand = {
  name: 'list',
  description: 'List all providers and their status',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context: CommandContext) => {
    const providers = getAllAfotProviderStatus();
    const activeName = resolveAfotActiveProviderName();

    const lines: string[] = [
      `AFOT Providers  (active: ${activeName ?? 'none'})`,
      '',
    ];

    for (const p of providers) {
      const star = p.name === activeName ? '▶ ' : '  ';
      const keyStatus = p.configured
        ? p.isLocal
          ? '(local)'
          : p.name === 'opencode'
            ? '(connected)'
            : '(key set)'
        : '(no key)';
      lines.push(`${star}${p.name.padEnd(14)} ${keyStatus}`);
      if (p.baseUrl) {
        lines.push(`    ${p.baseUrl}`);
      }
    }

    context.ui.addItem(
      { type: MessageType.INFO, text: lines.join('\n') },
      Date.now(),
    );
  },
};

/** /provider use <name> */
const providerUseCommand: SlashCommand = {
  name: 'use',
  description: 'Switch active provider for this session',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context: CommandContext, args: string) => {
    const name = args.trim();
    if (!name) {
      context.ui.addItem(
        { type: MessageType.ERROR, text: 'Usage: /provider use <name>' },
        Date.now(),
      );
      return;
    }

    const all = getAllAfotProviderStatus();
    const found = all.find((p) => p.name === name);
    if (!found) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Provider "${name}" not found. Run /provider list to see all providers.`,
        },
        Date.now(),
      );
      return;
    }
    if (!found.configured && !found.isLocal) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Provider "${name}" has no API key. Set it with: /provider set-key ${name} <your-key>`,
        },
        Date.now(),
      );
      return;
    }

    // Persist as default in config.json
    setAfotDefaultProvider(name);

    // Re-auth with the new provider
    const config = context.services.agentContext?.config;
    if (config) {
      try {
        await config.refreshAuth(AuthType.AFOT_AUTH);
        let models: string[] = [];
        let resolvedBaseUrl = found.baseUrl;
        if (name === 'opencode') {
          const opProv = await resolveOpenCodeProvider().catch(() => null);
          models = opProv?.models ?? [];
          if (opProv?.baseUrl) resolvedBaseUrl = opProv.baseUrl;
        } else {
          const prov = resolveAfotProviderByName(name);
          models = await fetchAfotProviderModels(prov);
          if (prov?.baseUrl) resolvedBaseUrl = prov.baseUrl;
        }

        const afotConfig = readAfotConfig();
        const configuredModel =
          afotConfig?.providers?.[name]?.defaultModel ||
          (afotConfig?.defaultProvider === name ? afotConfig.defaultModel : undefined);
        const targetModel =
          configuredModel && models.includes(configuredModel)
            ? configuredModel
            : models[0];

        if (targetModel) {
          config.setModel(targetModel, true);
        }
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `✓ Switched to provider: ${name}  (${resolvedBaseUrl || found.baseUrl || 'connected'})`,
          },
          Date.now(),
        );
      } catch (e) {
        context.ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Failed to switch: ${e instanceof Error ? e.message : String(e)}`,
          },
          Date.now(),
        );
      }
    } else {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `✓ Default provider saved: ${name}. Restart or run /provider use again to apply.`,
        },
        Date.now(),
      );
    }
  },
};

/** /provider set-key <name> <key> */
const providerSetKeyCommand: SlashCommand = {
  name: 'set-key',
  description: 'Set or update the API key for a provider',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: (context: CommandContext, args: string) => {
    const parts = args.trim().split(/\s+/);
    if (parts.length < 2) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Usage: /provider set-key <name> <api-key>',
        },
        Date.now(),
      );
      return;
    }
    const [name, key] = parts;
    setAfotProviderKey(name, key);
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: `✓ API key saved for provider "${name}"`,
      },
      Date.now(),
    );
  },
};

/** /provider models [name] */
const providerModelsCommand: SlashCommand = {
  name: 'models',
  description: 'List models for a provider (defaults to active provider)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context: CommandContext, args: string) => {
    const targetName = args.trim() || resolveAfotProvider()?.name;
    if (!targetName) {
      context.ui.addItem(
        { type: MessageType.ERROR, text: 'No active provider.' },
        Date.now(),
      );
      return;
    }
    const all = getAllAfotProviderStatus();
    const p = all.find((x) => x.name === targetName);
    if (!p) {
      context.ui.addItem(
        { type: MessageType.ERROR, text: `Provider "${targetName}" not found.` },
        Date.now(),
      );
      return;
    }
    let models = p.models;
    if (targetName === 'opencode') {
      models = (await resolveOpenCodeProvider().catch(() => null))?.models ?? [];
    } else {
      models = await fetchAfotProviderModels(resolveAfotProviderByName(targetName));
    }

    const lines = [
      `Models for ${p.name}  (${p.baseUrl}):`,
      '',
      ...(models.length > 0
        ? models.map((m) => `  ${m}`)
        : ['  (no live models returned by this provider)']),
    ];
    context.ui.addItem(
      { type: MessageType.INFO, text: lines.join('\n') },
      Date.now(),
    );
  },
};

export const providerCommand: SlashCommand = {
  name: 'provider',
  description: 'Manage AFOT providers',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    providerListCommand,
    providerUseCommand,
    providerSetKeyCommand,
    providerModelsCommand,
  ],
  action: (_context, _args) => providerListCommand.action!(_context, _args),
};
