/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subagentsCommand } from './subagentsCommand.js';
import type { CommandContext } from './types.js';
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

describe('subagentsCommand', () => {
  let mockContext: CommandContext;
  let mockAddItem: ReturnType<typeof vi.fn>;
  let mockGetDefinition: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddItem = vi.fn();
    mockGetDefinition = vi.fn().mockReturnValue({
      name: 'swarm_coder',
      displayName: 'Swarm Coder',
      description: 'Code modification worker',
      kind: 'local',
      toolConfig: { tools: ['read_file', 'edit'] },
    });

    mockContext = {
      services: {
        agentContext: {
          config: {
            getApprovalMode: vi.fn().mockReturnValue('default'),
            getAgentRegistry: vi.fn().mockReturnValue({
              getAllDefinitions: vi.fn().mockReturnValue([
                {
                  name: 'swarm_coder',
                  displayName: 'Swarm Coder',
                  description: 'Code modification worker',
                  kind: 'local',
                  toolConfig: { tools: ['read_file', 'edit'] },
                },
                {
                  name: 'swarm_explorer',
                  displayName: 'Swarm Explorer',
                  description: 'Codebase explorer',
                  kind: 'local',
                  toolConfig: { tools: ['glob', 'grep'] },
                },
              ]),
              getDefinition: mockGetDefinition,
            }),
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

  it('should list all subagents when executed without arguments', async () => {
    await subagentsCommand.action!(mockContext, '');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('AFOT Subagent Workspace & Switcher'),
      }),
    );
  });

  it('should switch and submit prompt when given "switch <agent> <prompt>"', async () => {
    const result = await subagentsCommand.action!(
      mockContext,
      'switch swarm_coder fix login endpoint',
    );
    expect(result).toEqual({
      type: 'submit_prompt',
      content: '@swarm_coder fix login endpoint',
    });
  });

  it('should strip leading @ from agent name in switch command', async () => {
    const switchSub = subagentsCommand.subCommands?.find(
      (s) => s.name === 'switch',
    );
    expect(switchSub).toBeDefined();

    const result = await switchSub!.action!(
      mockContext,
      '@swarm_coder refactor state',
    );
    expect(result).toEqual({
      type: 'submit_prompt',
      content: '@swarm_coder refactor state',
    });
  });
});
