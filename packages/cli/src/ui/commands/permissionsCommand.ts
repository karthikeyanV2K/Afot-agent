/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  OpenDialogActionReturn,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import * as process from 'node:process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { expandHomeDir } from '../utils/directoryUtils.js';
import {
  listGrants,
  grantPath,
  revokePath,
  isAllowAllPaths,
  setAllowAllPaths,
  isPathGuardDisabled,
  getSessionRoot,
  setAfotPermissions,
  setAfotRuntimePermissions,
} from '@google/gemini-cli-core';

function handleList(): SlashCommandActionReturn {
  const grants = listGrants();
  const allowAll = isAllowAllPaths() || isPathGuardDisabled();
  const root = getSessionRoot();

  const lines = [
    '## 🛡️ Directory & File Access Permissions',
    `**Session Root (CWD):** \`${root}\``,
    `**Unrestricted Directory Access:** ${allowAll ? '🚀 `ENABLED (all directories allowed)`' : '🛡️ `RESTRICTED to workspace`'}`,
    '',
    `### Active Path Grants (${grants.length}):`,
  ];

  if (grants.length === 0) {
    lines.push('_No additional path grants active._');
  } else {
    for (const g of grants) {
      lines.push(
        `- \`${g.realPath}\` (${g.scope === 'always' ? 'persisted' : 'session-only'})`,
      );
    }
  }

  lines.push(
    '',
    'Use `/permissions allow <path>` or `/permissions allow_all` to grant additional directory access.',
  );

  return {
    type: 'message',
    messageType: 'info',
    content: lines.join('\n'),
  };
}

function handleAllow(input: string): SlashCommandActionReturn {
  const target = input.trim();
  if (!target) {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'Please specify a directory path to allow. Usage: /permissions allow <path>',
    };
  }
  const resolved = path.resolve(expandHomeDir(target));
  grantPath(resolved, 'always');
  return {
    type: 'message',
    messageType: 'info',
    content: `Granted persistent access to: \`${resolved}\``,
  };
}

function handleAllowAll(input: string): SlashCommandActionReturn {
  const val = input.trim().toLowerCase();
  const enable =
    val === 'on' || val === 'true' || val === '1'
      ? true
      : val === 'off' || val === 'false' || val === '0'
        ? false
        : !isAllowAllPaths();
  setAllowAllPaths(enable);
  setAfotRuntimePermissions({ allowAllPaths: enable });
  setAfotPermissions({ allowAllPaths: enable });
  return {
    type: 'message',
    messageType: 'info',
    content: enable
      ? '🚀 Unrestricted Directory Access: `ENABLED`. Tools and shell commands can now access any directory without prompts.'
      : '🛡️ Unrestricted Directory Access: `DISABLED`. Restricted to session workspace root.',
  };
}

function handleRevoke(input: string): SlashCommandActionReturn {
  const target = input.trim();
  if (!target) {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'Please specify a path to revoke. Usage: /permissions revoke <path>',
    };
  }
  const resolved = path.resolve(expandHomeDir(target));
  revokePath(resolved);
  return {
    type: 'message',
    messageType: 'info',
    content: `Revoked access grant for: \`${resolved}\``,
  };
}

export const permissionsCommand: SlashCommand = {
  name: 'permissions',
  description: 'Manage folder trust settings and other permissions',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'trust',
      description:
        'Manage folder trust settings. Usage: /permissions trust [<directory-path>]',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: (context, input): SlashCommandActionReturn => {
        const dirPath = input.trim();
        let targetDirectory: string;

        if (!dirPath) {
          targetDirectory = process.cwd();
        } else {
          targetDirectory = path.resolve(expandHomeDir(dirPath));
        }

        try {
          if (!fs.statSync(targetDirectory).isDirectory()) {
            return {
              type: 'message',
              messageType: 'error',
              content: `Path is not a directory: ${targetDirectory}`,
            };
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return {
            type: 'message',
            messageType: 'error',
            content: `Error accessing path: ${targetDirectory}. ${message}`,
          };
        }

        return {
          type: 'dialog',
          dialog: 'permissions',
          props: {
            targetDirectory,
          },
        } as OpenDialogActionReturn;
      },
    },
    {
      name: 'list',
      description:
        'List active path grants and unrestricted directory access status',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (): SlashCommandActionReturn => handleList(),
    },
    {
      name: 'allow',
      description:
        'Grant persistent access to a directory outside workspace. Usage: /permissions allow <path>',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (context, input): SlashCommandActionReturn => handleAllow(input),
    },
    {
      name: 'allow_all',
      altNames: ['all'],
      description:
        'Enable or disable unrestricted directory access across all drives. Usage: /permissions allow_all [on|off]',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (context, input): SlashCommandActionReturn =>
        handleAllowAll(input),
    },
    {
      name: 'revoke',
      description:
        'Revoke path grants for a directory. Usage: /permissions revoke <path>',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (context, input): SlashCommandActionReturn => handleRevoke(input),
    },
  ],
  action: (context, input): SlashCommandActionReturn => {
    const parts = input.trim().split(' ');
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Please provide a subcommand for /permissions. Usage: /permissions trust [<directory-path>] | list | allow <path> | allow_all [on|off] | revoke <path>`,
      };
    }

    if (subcommand === 'list') {
      return handleList();
    }
    if (subcommand === 'allow') {
      return handleAllow(parts.slice(1).join(' '));
    }
    if (subcommand === 'allow_all' || subcommand === 'all') {
      return handleAllowAll(parts.slice(1).join(' '));
    }
    if (subcommand === 'revoke') {
      return handleRevoke(parts.slice(1).join(' '));
    }

    return {
      type: 'message',
      messageType: 'error',
      content: `Invalid subcommand for /permissions: ${subcommand}. Usage: /permissions trust [<directory-path>] | list | allow <path> | allow_all [on|off] | revoke <path>`,
    };
  },
};
