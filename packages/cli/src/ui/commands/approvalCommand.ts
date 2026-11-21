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
import {
  ApprovalMode,
  PolicyDecision,
  coreEvents,
  debugLogger,
  isPathGuardDisabled,
  isAllowAllPaths,
  setAllowAllPaths,
  isAfotAutoApproveShellEnabled,
  isAfotAutoApproveEnabled,
  setAfotApprovalMode,
  setAfotPermissions,
  setAfotRuntimePermissions,
} from '@google/gemini-cli-core';
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
    {
      name: 'paths',
      altNames: ['allow_paths', 'allow_all_paths'],
      description:
        'Toggle or set unrestricted access to all filesystem directories outside current workspace',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext, rawArgs?: string) =>
        togglePaths(context, rawArgs),
    },
    {
      name: 'shell',
      altNames: ['auto_shell'],
      description:
        'Toggle or set auto-approval for shell command execution without full YOLO mode',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext, rawArgs?: string) =>
        toggleShell(context, rawArgs),
    },
    {
      name: 'save',
      description:
        'Persist current approval mode and permissions to ~/.afot/config.json so they survive restarts',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) => saveSettings(context),
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
      const pathsAllowed = isPathGuardDisabled() || isAllowAllPaths();
      const shellAutoApprove =
        currentMode === ApprovalMode.YOLO ||
        isAfotAutoApproveShellEnabled() ||
        isAfotAutoApproveEnabled();

      const lines: string[] = [
        `## 🔐 Subagent Work Approver & Mode Switcher`,
        `**Current Active Mode:** \`${currentMode.toUpperCase()}\``,
        `**Directory Path Access:** ${pathsAllowed ? '🚀 Unrestricted (all directories allowed)' : '🛡️ Restricted to session root (path guard active)'}`,
        `**Shell Auto-Approval:** ${shellAutoApprove ? '🚀 Auto-approved (no confirmation prompts)' : '🛡️ Interactive confirmation required'}`,
        `**Workspace Trust:** ${isTrusted ? '✅ Trusted' : '⚠️ Untrusted (privileged modes require trust)'}`,
        '',
        getModeDescription(currentMode),
        '',
        `### Available Commands & Options:`,
        `- \`/approver yolo\` — Full autonomous execution for subagents without confirmation dialogs.`,
        `- \`/approver auto_edit\` — Automatically approve file edits; prompt user only for shell commands.`,
        `- \`/approver default\` — Standard interactive mode: prompts confirmation for every file write & shell execution.`,
        `- \`/approver plan\` — Safe read-only planning mode.`,
        `- \`/approver paths [on|off]\` — Toggle unrestricted access to any directory outside the current workspace.`,
        `- \`/approver shell [on|off]\` — Toggle auto-approval for shell commands without full YOLO mode.`,
        `- \`/approver save\` — Save current mode & permissions to \`~/.afot/config.json\` across sessions.`,
      ];

      context.ui.addItem({
        type: MessageType.GEMINI,
        text: lines.join('\n'),
      });
      return;
    }

    const lower = args.toLowerCase();
    if (lower.startsWith('paths') || lower.startsWith('allow_paths') || lower.startsWith('allow_all_paths')) {
      const parts = args.split(/\s+/);
      await togglePaths(context, parts.slice(1).join(' '));
      return;
    }
    if (lower.startsWith('shell') || lower.startsWith('auto_shell')) {
      const parts = args.split(/\s+/);
      await toggleShell(context, parts.slice(1).join(' '));
      return;
    }
    if (lower === 'save') {
      await saveSettings(context);
      return;
    }

    const targetMode = parseApprovalMode(args);
    if (!targetMode) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: `Unknown approval mode or option "${args}". Choose from: \`default\`, \`auto_edit\`, \`yolo\`, \`plan\`, \`paths\`, \`shell\`, \`save\`.`,
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

async function togglePaths(
  context: CommandContext,
  rawArg?: string,
): Promise<void> {
  const arg = rawArg?.trim().toLowerCase();
  let nextState: boolean;
  if (arg === 'on' || arg === 'true' || arg === '1' || arg === 'enable') {
    nextState = true;
  } else if (
    arg === 'off' ||
    arg === 'false' ||
    arg === '0' ||
    arg === 'disable'
  ) {
    nextState = false;
  } else {
    // Toggle
    nextState = !(isPathGuardDisabled() || isAllowAllPaths());
  }

  setAllowAllPaths(nextState);
  setAfotRuntimePermissions({ allowAllPaths: nextState });
  setAfotPermissions({ allowAllPaths: nextState });
  coreEvents.emitFeedback(
    'info',
    `Unrestricted directory access is now ${nextState ? 'ENABLED (all directories allowed)' : 'DISABLED (restricted to workspace)'}.`,
  );
  context.ui.addItem({
    type: MessageType.GEMINI,
    text: nextState
      ? '### 🚀 Unrestricted Directory Access: `ENABLED`\nTools and shell commands can now freely read, write, move, and organize files in any directory across all drives without prompts.'
      : '### 🛡️ Unrestricted Directory Access: `DISABLED`\nPathGuard is active. Filesystem tools are restricted to the session workspace root.',
  });
}

async function toggleShell(
  context: CommandContext,
  rawArg?: string,
): Promise<void> {
  const arg = rawArg?.trim().toLowerCase();
  let nextState: boolean;
  if (arg === 'on' || arg === 'true' || arg === '1' || arg === 'enable') {
    nextState = true;
  } else if (
    arg === 'off' ||
    arg === 'false' ||
    arg === '0' ||
    arg === 'disable'
  ) {
    nextState = false;
  } else {
    // Toggle
    nextState = !isAfotAutoApproveShellEnabled();
  }

  setAfotRuntimePermissions({ autoApproveShell: nextState });
  setAfotPermissions({ autoApproveShell: nextState });
  const config = context.services.agentContext?.config;
  const policyEngine = config?.getPolicyEngine?.();
  if (policyEngine) {
    policyEngine.removeRulesBySource('Command (/approver shell on)');
    if (nextState) {
      policyEngine.addRule({
        toolName: 'run_shell_command',
        decision: PolicyDecision.ALLOW,
        priority: 998,
        source: 'Command (/approver shell on)',
        allowRedirection: true,
        allowCommandSubstitution: true,
      });
    }
  }
  coreEvents.emitFeedback(
    'info',
    `Shell command auto-approval is now ${nextState ? 'ENABLED (auto-approves without prompts)' : 'DISABLED (prompts for confirmation)'}.`,
  );
  context.ui.addItem({
    type: MessageType.GEMINI,
    text: nextState
      ? '### 🚀 Shell Auto-Approval: `ENABLED`\nShell commands and scripts execute automatically without prompting for confirmation.'
      : '### 🛡️ Shell Auto-Approval: `DISABLED`\nShell commands will prompt for interactive confirmation.',
  });
}

async function saveSettings(context: CommandContext): Promise<void> {
  const config = context.services.agentContext?.config;
  const currentMode = config ? config.getApprovalMode() : ApprovalMode.DEFAULT;
  const pathsAllowed = isPathGuardDisabled() || isAllowAllPaths();
  const shellAutoApprove = isAfotAutoApproveShellEnabled();

  try {
    setAfotApprovalMode(currentMode);
    setAfotPermissions({
      allowAllPaths: pathsAllowed,
      autoApproveShell: shellAutoApprove,
      autoApprove: currentMode === ApprovalMode.YOLO,
    });
    coreEvents.emitFeedback(
      'info',
      `Saved approval mode (${currentMode.toUpperCase()}) and permissions to ~/.afot/config.json.`,
    );
    context.ui.addItem({
      type: MessageType.GEMINI,
      text: `### 💾 Settings Saved to \`~/.afot/config.json\`\n- **Default Approval Mode:** \`${currentMode.toUpperCase()}\`\n- **Allow All Paths:** \`${pathsAllowed ? 'true' : 'false'}\`\n- **Auto-Approve Shell:** \`${shellAutoApprove ? 'true' : 'false'}\`\n\nThese preferences will persist automatically across CLI sessions.`,
    });
  } catch (err) {
    debugLogger.error('Failed to save settings:', err);
    coreEvents.emitFeedback(
      'error',
      `Failed to save settings: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
