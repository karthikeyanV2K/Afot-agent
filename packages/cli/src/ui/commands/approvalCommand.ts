/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import { ApprovalMode, coreEvents, debugLogger } from '@google/gemini-cli-core';
import { MessageType } from '../types.js';

function getModeDescription(mode: ApprovalMode): string {
  switch (mode) {
    case ApprovalMode.YOLO:
      return '🚀 **YOLO Mode (Full Autonomy)**: Subagents and tools run automatically without manual confirmation prompts. Edits, shell commands, and web requests execute immediately.';
    case ApprovalMode.AUTO_EDIT:
      return '✍️ **Auto-Edit Mode**: Subagents automatically edit and write files without prompting. Shell commands and bash executions still require manual user confirmation.';
    case ApprovalMode.PLAN:
      return '📋 **Plan Mode (Read-Only)**: Subagents operate in read-only analysis mode. Modifying files or running destructive shell commands is restricted.';
    case ApprovalMode.DEFAULT:
    default:
      return '🛡️ **Default Mode (Interactive Approver)**: Subagents run read-only tools automatically, but pause and request manual confirmation before editing files or running shell commands.';
  }
}

function parseApprovalMode(input: string): ApprovalMode | null {
  const normalized = input.trim().toLowerCase().replace(/[-_]/g, '');
  if (normalized === 'yolo') return ApprovalMode.YOLO;
  if (normalized === 'autoedit' || normalized === 'edit')
    return ApprovalMode.AUTO_EDIT;
  if (normalized === 'plan') return ApprovalMode.PLAN;
  if (normalized === 'default' || normalized === 'normal')
    return ApprovalMode.DEFAULT;
  return null;
}

export const approvalCommand: SlashCommand = {
  name: 'approver',
  altNames: ['approval', 'approval-mode', 'mode'],
  description:
    'Inspect or switch subagent approval and confirmation modes (default, auto_edit, yolo, plan)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'yolo',
      description: 'Switch to YOLO mode (auto-approve all subagent actions)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) =>
        setMode(context, ApprovalMode.YOLO),
    },
    {
      name: 'auto_edit',
      altNames: ['autoedit'],
      description:
        'Switch to Auto-Edit mode (auto-approve file edits, prompt on shell)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) =>
        setMode(context, ApprovalMode.AUTO_EDIT),
    },
    {
      name: 'default',
      description:
        'Switch to Default mode (interactive confirmation for all writes)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) =>
        setMode(context, ApprovalMode.DEFAULT),
    },
    {
      name: 'plan',
      description: 'Switch to Plan mode (safe read-only exploration)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) =>
        setMode(context, ApprovalMode.PLAN),
    },
  ],
  action: async (context: CommandContext, rawArgs?: string) => {
    const args = rawArgs?.trim() ?? '';
    const config = context.services.agentContext?.config;

    if (!config) {
      coreEvents.emitFeedback('error', 'Config not available.');
      return;
    }

    if (!args) {
      const currentMode = config.getApprovalMode();
      const isTrusted = config.isTrustedFolder();

      const lines: string[] = [
        `## 🔐 Subagent Work Approver & Mode Switcher`,
        `**Current Active Mode:** \`${currentMode.toUpperCase()}\``,
        `**Workspace Trust:** ${isTrusted ? '✅ Trusted' : '⚠️ Untrusted (privileged modes require trust)'}`,
        '',
        getModeDescription(currentMode),
        '',
        `### Available Approval Modes:`,
        `- \`/approver yolo\` — Full autonomous execution for subagents without confirmation dialogs.`,
        `- \`/approver auto_edit\` — Automatically approve file edits; prompt user only for shell commands.`,
        `- \`/approver default\` — Standard interactive mode: prompts confirmation for every file write & shell execution.`,
        `- \`/approver plan\` — Safe read-only planning mode.`,
      ];

      context.ui.addItem({
        type: MessageType.GEMINI,
        text: lines.join('\n'),
      });
      return;
    }

    const targetMode = parseApprovalMode(args);
    if (!targetMode) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: `Unknown approval mode "${args}". Choose from: \`default\`, \`auto_edit\`, \`yolo\`, \`plan\`.`,
      });
      return;
    }

    await setMode(context, targetMode);
  },
};

async function setMode(
  context: CommandContext,
  mode: ApprovalMode,
): Promise<void> {
  const config = context.services.agentContext?.config;
  if (!config) {
    coreEvents.emitFeedback('error', 'Config not available.');
    return;
  }

  const prevMode = config.getApprovalMode();
  if (prevMode === mode) {
    coreEvents.emitFeedback(
      'info',
      `Approval mode is already ${mode.toUpperCase()}.`,
    );
    return;
  }

  try {
    config.setApprovalMode(mode);
    coreEvents.emitFeedback(
      'info',
      `Switched subagent approval mode to ${mode.toUpperCase()}.`,
    );
    context.ui.addItem({
      type: MessageType.GEMINI,
      text: `### 🔐 Subagent Approval Mode Changed: \`${mode.toUpperCase()}\`\n\n${getModeDescription(
        mode,
      )}`,
    });
  } catch (err) {
    debugLogger.error('Failed to change approval mode:', err);
    coreEvents.emitFeedback(
      'error',
      `Could not switch approval mode: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
