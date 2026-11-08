/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { undoCommand } from './undoCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import { coreEvents } from '@google/gemini-cli-core';

const mockRevertFileChanges = vi.fn();
const mockRewindConversation = vi.fn();
const mockRewindAction = vi.fn();
const mockCalculateTurnStats = vi.fn();
const mockGetCleanedRewindText = vi.fn().mockReturnValue('restored prompt text');

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    coreEvents: {
      ...actual.coreEvents,
      emitFeedback: vi.fn(),
    },
  };
});

vi.mock('../utils/rewindFileOps.js', () => ({
  revertFileChanges: (...args: unknown[]) => mockRevertFileChanges(...args),
  isToolResponseMessage: vi.fn().mockReturnValue(false),
  calculateTurnStats: (...args: unknown[]) => mockCalculateTurnStats(...args),
}));

vi.mock('./rewindCommand.js', () => ({
  rewindConversation: (...args: unknown[]) => mockRewindConversation(...args),
  rewindCommand: {
    name: 'rewind',
    action: (...args: unknown[]) => mockRewindAction(...args),
  },
}));

vi.mock('../components/RewindViewer.js', () => ({
  getCleanedRewindText: (...args: unknown[]) => mockGetCleanedRewindText(...args),
}));

describe('undoCommand', () => {
  let mockContext: CommandContext;
  const mockGetConversation = vi.fn();
  const mockGetChatRecordingService = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetConversation.mockReturnValue({
      messages: [
        { id: 'msg-1', type: 'user', content: 'hello' },
        { id: 'msg-2', type: 'gemini', content: 'hi there' },
      ],
      sessionId: 'test-session',
    });

    mockGetChatRecordingService.mockReturnValue({
      getConversation: mockGetConversation,
    });

    mockContext = createMockCommandContext({
      services: {
        agentContext: {
          config: {} as any,
          geminiClient: {
            getChatRecordingService: mockGetChatRecordingService,
          } as any,
        } as any,
      },
    });
  });

  it('delegates to rewindCommand when args is list or --interactive', async () => {
    mockRewindAction.mockResolvedValue({ type: 'custom_dialog' });
    const result = await undoCommand.action!(mockContext, 'list');
    expect(mockRewindAction).toHaveBeenCalledWith(mockContext, 'list');
    expect(result).toEqual({ type: 'custom_dialog' });
  });

  it('returns error if config is not found', async () => {
    const contextWithoutConfig = createMockCommandContext({
      services: { agentContext: null },
    }) as unknown as CommandContext;
    const result = await undoCommand.action!(contextWithoutConfig, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not found',
    });
  });

  it('returns error if client is not initialized', async () => {
    const contextWithoutClient = createMockCommandContext({
      services: {
        agentContext: {
          config: {} as any,
          geminiClient: null,
        } as any,
      },
    });
    const result = await undoCommand.action!(contextWithoutClient, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Client not initialized',
    });
  });

  it('returns error if recording service is unavailable', async () => {
    const contextWithoutService = createMockCommandContext({
      services: {
        agentContext: {
          config: {} as any,
          geminiClient: {
            getChatRecordingService: () => null,
          } as any,
        } as any,
      },
    });
    const result = await undoCommand.action!(contextWithoutService, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Recording service unavailable',
    });
  });

  it('returns info message if there are no user messages to undo', async () => {
    mockGetConversation.mockReturnValue({ messages: [] });
    const result = await undoCommand.action!(mockContext, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Nothing to undo.',
    });
  });

  it('successfully reverts file changes and rewinds the last user turn', async () => {
    mockCalculateTurnStats.mockReturnValue(null);

    const result = await undoCommand.action!(mockContext, '');

    expect(mockRevertFileChanges).toHaveBeenCalledWith(
      expect.anything(),
      'msg-1',
    );
    expect(mockRewindConversation).toHaveBeenCalledWith(
      mockContext,
      expect.anything(),
      expect.anything(),
      'msg-1',
      'restored prompt text',
    );
    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'info',
      '✓ Undid last turn and restored prompt.',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: '✓ Undid last turn and restored prompt.',
    });
  });

  it('reports reverted file statistics when files were modified', async () => {
    mockCalculateTurnStats.mockReturnValue({
      fileCount: 2,
      addedLines: 15,
      removedLines: 4,
    });

    const result = await undoCommand.action!(mockContext, '');

    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'info',
      '✓ Undid last turn: reverted 2 file(s) (+15/-4).',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: '✓ Undid last turn: reverted 2 file(s) (+15/-4).',
    });
  });
});
