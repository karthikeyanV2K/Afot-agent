/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { swarmCommand } from './swarmCommand.js';
import type { CommandContext } from './types.js';
import { MessageType } from '../types.js';
import { AfotSwarmOrchestrator } from '@google/gemini-cli-core';

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    AfotSwarmOrchestrator: vi.fn(),
    coreEvents: {
      emitFeedback: vi.fn(),
    },
  };
});

describe('swarmCommand', () => {
  let mockContext: CommandContext;
  let mockAddItem: ReturnType<typeof vi.fn>;
  let mockPlanGoal: ReturnType<typeof vi.fn>;
  let mockExecuteSwarm: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddItem = vi.fn();
    mockPlanGoal = vi.fn().mockResolvedValue({
      goal: 'Test Goal',
      tasks: [
        {
          id: 'task-1',
          title: 'Explore codebase',
          worker: 'explorer',
          brief: 'Find auth files',
          dependencies: [],
          status: 'pending',
        },
        {
          id: 'task-2',
          title: 'Implement changes',
          worker: 'coder',
          brief: 'Add PKCE logic',
          dependencies: ['task-1'],
          status: 'pending',
        },
      ],
      waves: [['task-1'], ['task-2']],
    });
    mockExecuteSwarm = vi.fn().mockResolvedValue({
      goal: 'Test Goal',
      plan: { tasks: [], waves: [] },
      tasks: [],
      summary: 'Swarm completed successfully.',
      success: true,
      totalDurationMs: 4200,
      tokensSavedEstimate: 45000,
      completedCount: 2,
      failedCount: 0,
    });

    vi.mocked(AfotSwarmOrchestrator).mockImplementation(
      () =>
        ({
          planGoal: mockPlanGoal,
          executeSwarm: mockExecuteSwarm,
          runGoal: vi.fn(),
        }) as unknown as AfotSwarmOrchestrator,
    );

    mockContext = {
      services: {
        agentContext: {
          config: {
            getActiveModel: vi.fn().mockReturnValue('minimaxai/minimax-m3.1-flash'),
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

  it('should have correct name, aliases, and AGY subcommands', () => {
    expect(swarmCommand.name).toBe('swarm');
    expect(swarmCommand.altNames).toContain('orchestrate');
    const subNames = swarmCommand.subCommands?.map((s) => s.name);
    expect(subNames).toContain('status');
    expect(subNames).toContain('board');
    expect(subNames).toContain('post');
    expect(subNames).toContain('add');
    expect(subNames).toContain('kill');
    expect(subNames).toContain('model');
    expect(subNames).toContain('models');
    expect(subNames).toContain('title');
    expect(subNames).toContain('plan');
    expect(subNames).toContain('run');
    expect(subNames).toContain('workers');
    expect(subNames).toContain('reset');
  });

  it('should show AGY swarm coordinator dashboard when executed with no arguments', async () => {
    await swarmCommand.action!(mockContext, '');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('AFOT SWARM COORDINATOR & MESSAGE BOARD'),
      }),
    );
  });

  it('should display worker roster on "status"', async () => {
    await swarmCommand.action!(mockContext, 'status');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('AFOT Swarm Worker Roster'),
      }),
    );
  });

  it('should add a worker to the roster on "add <name> <brief>"', async () => {
    await swarmCommand.action!(mockContext, 'add coder Implement auth tests');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('Worker Added to Swarm Roster'),
      }),
    );
  });

  it('should post message to the shared board on "post @worker message"', async () => {
    await swarmCommand.action!(mockContext, 'post @coder Please refactor auth.ts');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('Posted to Board'),
      }),
    );
  });

  it('should display board messages on "board"', async () => {
    await swarmCommand.action!(mockContext, 'board');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('AFOT Swarm Message Board'),
      }),
    );
  });

  it('should terminate worker on "kill <name>"', async () => {
    await swarmCommand.action!(mockContext, 'add tester Run tests');
    await swarmCommand.action!(mockContext, 'kill tester');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('Worker @tester has been terminated'),
      }),
    );
  });

  it('should show workers table on "workers"', async () => {
    await swarmCommand.action!(mockContext, 'workers');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('AFOT Swarm Worker Archetypes'),
      }),
    );
  });

  it('should plan and preview DAG waves on "plan <goal>"', async () => {
    await swarmCommand.action!(mockContext, 'plan Implement OAuth PKCE');
    expect(mockPlanGoal).toHaveBeenCalledWith('Implement OAuth PKCE');
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.GEMINI,
        text: expect.stringContaining('AFOT Parallel Swarm Plan'),
      }),
    );
    expect(mockExecuteSwarm).not.toHaveBeenCalled();
  });

  it('should plan and execute full parallel swarm on "<goal>"', async () => {
    await swarmCommand.action!(mockContext, 'Implement OAuth PKCE');
    expect(mockPlanGoal).toHaveBeenCalledWith('Implement OAuth PKCE');
    expect(mockExecuteSwarm).toHaveBeenCalled();
    expect(mockAddItem).toHaveBeenCalledTimes(2); // Plan display + final summary
  });
});
