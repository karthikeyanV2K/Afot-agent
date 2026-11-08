/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from './types.js';
import {
  revertFileChanges,
  isToolResponseMessage,
  calculateTurnStats,
} from '../utils/rewindFileOps.js';
import { rewindConversation, rewindCommand } from './rewindCommand.js';
import { getCleanedRewindText } from '../components/RewindViewer.js';
import { coreEvents, type MessageActionReturn } from '@google/gemini-cli-core';

export const undoCommand: SlashCommand = {
  name: 'undo',
  description: 'Undo the last turn and immediately revert all file changes',
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args?: string,
  ): Promise<MessageActionReturn | void> => {
    // If user explicitly asks for interactive or list, delegate to interactive rewind viewer
    if (
      args &&
      (args.trim() === 'list' ||
        args.trim() === '--interactive' ||
        args.trim() === '-i')
    ) {
      if (rewindCommand.action) {
        return rewindCommand.action(context, args) as unknown as Promise<MessageActionReturn | void>;
      }
      return;
    }

    const agentContext = context.services.agentContext;
    const config = agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not found',
      };
    }

    const client = agentContext.geminiClient;
    if (!client) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Client not initialized',
      };
    }

    const recordingService = client.getChatRecordingService();
    if (!recordingService) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Recording service unavailable',
      };
    }

    const conversation = recordingService.getConversation();
    if (!conversation) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No conversation found.',
      };
    }

    const userMessages = conversation.messages.filter(
      (msg) => msg.type === 'user' && !isToolResponseMessage(msg),
    );

    if (userMessages.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Nothing to undo.',
      };
    }

    const lastUserMessage = userMessages[userMessages.length - 1];
    const turnStats = calculateTurnStats(conversation, lastUserMessage);
    const newText = getCleanedRewindText(lastUserMessage);

    // 1. Revert any file modifications made during that turn
    await revertFileChanges(conversation, lastUserMessage.id);

    // 2. Rewind the conversation state and restore previous user prompt into input box
    await rewindConversation(
      context,
      client,
      recordingService,
      lastUserMessage.id,
      newText,
    );

    let summary = '✓ Undid last turn and restored prompt.';
    if (turnStats && turnStats.fileCount > 0) {
      summary = `✓ Undid last turn: reverted ${turnStats.fileCount} file(s) (+${turnStats.addedLines}/-${turnStats.removedLines}).`;
    }

    coreEvents.emitFeedback('info', summary);
    return {
      type: 'message',
      messageType: 'info',
      content: summary,
    };
  },
};
