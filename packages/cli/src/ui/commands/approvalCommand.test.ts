/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { approvalCommand } from './approvalCommand.js';
import type { CommandContext } from './types.js';
import { ApprovalMode } from '@google/gemini-cli-core';
import { MessageType } from '../types.js';

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    coreEvents: {
      emitFeedback: vi.fn(),
    },
  };
});

describe('approvalCommand', () => {
  let mockContext: CommandContext;
  let mockAddItem: ReturnType<typeof vi.fn>;
  let mockSetApprovalMode: ReturnType<typeof vi.fn>;
  let mockGetApprovalMode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddItem = vi.fn();
    mockSetApprovalMode = vi.fn();
    mockGetApprovalMode = vi.fn().mockReturnValue(ApprovalMode.DEFAULT);

    mockContext = {
      services: {
        agentContext: {
          config: {
            getApprovalMode: mockGetApprovalMode,
            setApprovalMode: mockSetApprovalMode,
            isTrustedFolder: vi.fn().mockReturnValue(true),
          },
        } as never,
        settings: {} as never,
        git: undefined,
        logger: {} as never,
      },
      ui: {
        addItem: mockAddItem,
        clear: vi.fn(),
        setDebugMessage: vi.fn(),
        pendingItem: null,
        setPendingItem: vi.fn(),
      } as never,
    } as unknown as CommandContext;
  });

  it('should display active approval mode and options when called without args', async () => {
    await approvalCommand.action!(mockContext, '');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('Subagent Work Approver'),
      }),
    );
  });

  it('should switch mode to YOLO when given "yolo"', async () => {
    await approvalCommand.action!(mockContext, 'yolo');
    expect(mockSetApprovalMode).toHaveBeenCalledWith(ApprovalMode.YOLO);
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('YOLO'),
      }),
    );
  });

  it('should switch mode to AUTO_EDIT when given "auto_edit"', async () => {
    await approvalCommand.action!(mockContext, 'auto_edit');
    expect(mockSetApprovalMode).toHaveBeenCalledWith(ApprovalMode.AUTO_EDIT);
  });

  it('should report error on unrecognized mode', async () => {
    await approvalCommand.action!(mockContext, 'invalid_mode');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining('Unknown approval mode'),
      }),
    );
    expect(mockSetApprovalMode).not.toHaveBeenCalled();
  });

  it('should toggle paths unrestricted directory access', async () => {
    await approvalCommand.action!(mockContext, 'paths on');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('Unrestricted Directory Access: `ENABLED`'),
      }),
    );

    await approvalCommand.action!(mockContext, 'paths off');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('Unrestricted Directory Access: `DISABLED`'),
      }),
    );
  });

  it('should toggle shell command auto-approval', async () => {
    await approvalCommand.action!(mockContext, 'shell on');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('Shell Auto-Approval: `ENABLED`'),
      }),
    );

    await approvalCommand.action!(mockContext, 'shell off');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('Shell Auto-Approval: `DISABLED`'),
      }),
    );
  });

  it('should save settings when requested', async () => {
    await approvalCommand.action!(mockContext, 'save');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('Settings Saved to `~/.afot/config.json`'),
      }),
    );
  });
});
