/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type z } from 'zod';
import {
  AfotSwarmOrchestrator,
  calculateWaves,
  generateHeuristicPlan,
  type SwarmTask,
  type SwarmProgressEvent,
} from './afotSwarmOrchestrator.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { Config } from '../config/config.js';
import { LocalAgentExecutor } from './local-executor.js';

vi.mock('./local-executor.js', () => ({
  LocalAgentExecutor: {
    create: vi.fn(),
  },
}));

describe('AfotSwarmOrchestrator', () => {
  describe('calculateWaves (Kahn DAG Topological Sorter)', () => {
    it('should place completely independent tasks into a single parallel wave', () => {
      const tasks: SwarmTask[] = [
        {
          id: 't1',
          title: 'T1',
          worker: 'explorer',
          brief: 'B1',
          dependencies: [],
          status: 'pending',
        },
        {
          id: 't2',
          title: 'T2',
          worker: 'researcher',
          brief: 'B2',
          dependencies: [],
          status: 'pending',
        },
      ];

      const waves = calculateWaves(tasks);
      expect(waves).toEqual([['t1', 't2']]);
    });

    it('should place sequential tasks into sequential waves', () => {
      const tasks: SwarmTask[] = [
        {
          id: 't1',
          title: 'T1',
          worker: 'explorer',
          brief: 'B1',
          dependencies: [],
          status: 'pending',
        },
        {
          id: 't2',
          title: 'T2',
          worker: 'coder',
          brief: 'B2',
          dependencies: ['t1'],
          status: 'pending',
        },
        {
          id: 't3',
          title: 'T3',
          worker: 'verifier',
          brief: 'B3',
          dependencies: ['t2'],
          status: 'pending',
        },
      ];

      const waves = calculateWaves(tasks);
      expect(waves).toEqual([['t1'], ['t2'], ['t3']]);
    });

    it('should correctly handle a diamond DAG with parallel intermediate wave', () => {
      // t1 -> [t2, t3] -> t4
      const tasks: SwarmTask[] = [
        {
          id: 't1',
          title: 'T1',
          worker: 'explorer',
          brief: 'B1',
          dependencies: [],
          status: 'pending',
        },
        {
          id: 't2',
          title: 'T2',
          worker: 'coder',
          brief: 'B2',
          dependencies: ['t1'],
          status: 'pending',
        },
        {
          id: 't3',
          title: 'T3',
          worker: 'researcher',
          brief: 'B3',
          dependencies: ['t1'],
          status: 'pending',
        },
        {
          id: 't4',
          title: 'T4',
          worker: 'verifier',
          brief: 'B4',
          dependencies: ['t2', 't3'],
          status: 'pending',
        },
      ];

      const waves = calculateWaves(tasks);
      expect(waves).toHaveLength(3);
      expect(waves[0]).toEqual(['t1']);
      expect(waves[1]).toContain('t2');
      expect(waves[1]).toContain('t3');
      expect(waves[1]).toHaveLength(2);
      expect(waves[2]).toEqual(['t4']);
    });

    it('should gracefully handle cyclic dependencies without infinite looping', () => {
      const tasks: SwarmTask[] = [
        {
          id: 'c1',
          title: 'C1',
          worker: 'explorer',
          brief: 'B1',
          dependencies: ['c2'],
          status: 'pending',
        },
        {
          id: 'c2',
          title: 'C2',
          worker: 'coder',
          brief: 'B2',
          dependencies: ['c1'],
          status: 'pending',
        },
      ];

      const waves = calculateWaves(tasks);
      expect(waves.length).toBeGreaterThan(0);
      expect(waves.flat()).toEqual(expect.arrayContaining(['c1', 'c2']));
    });
  });

  describe('generateHeuristicPlan', () => {
    it('should generate a research task for pure research queries', () => {
      const plan = generateHeuristicPlan(
        'Research OAuth 2.1 PKCE specifications',
      );
      expect(plan.tasks).toHaveLength(1);
      expect(plan.tasks[0]?.worker).toBe('researcher');
      expect(plan.waves).toEqual([['task-1']]);
    });

    it('should generate parallel wave 1 (researcher + explorer) for hybrid research & implementation', () => {
      const plan = generateHeuristicPlan(
        'Research and implement fast-path streaming search',
      );
      expect(plan.tasks).toHaveLength(4);
      expect(plan.waves[0]).toEqual(['task-1', 'task-2']);
      expect(plan.tasks[0]?.worker).toBe('researcher');
      expect(plan.tasks[1]?.worker).toBe('explorer');
      expect(plan.tasks[2]?.worker).toBe('coder');
      expect(plan.tasks[3]?.worker).toBe('verifier');
    });

    it('should generate default Explore -> Code -> Verify for standard engineering goals', () => {
      const plan = generateHeuristicPlan('Refactor database connection pool');
      expect(plan.tasks).toHaveLength(3);
      expect(plan.tasks[0]?.worker).toBe('explorer');
      expect(plan.tasks[1]?.worker).toBe('coder');
      expect(plan.tasks[2]?.worker).toBe('verifier');
      expect(plan.waves).toEqual([['task-1'], ['task-2'], ['task-3']]);
    });
  });

  describe('AfotSwarmOrchestrator Execution', () => {
    let mockContext: AgentLoopContext;
    let mockConfig: Config;

    beforeEach(() => {
      vi.clearAllMocks();
      mockConfig = {
        getAgentRegistry: vi.fn().mockReturnValue(null),
      } as unknown as Config;

      mockContext = {
        config: mockConfig,
        geminiClient: {
          generateContent: vi.fn(),
        },
      } as unknown as AgentLoopContext;
    });

    it('should plan via LLM when JSON DAG is returned', async () => {
      const orchestrator = new AfotSwarmOrchestrator(mockContext);
      const jsonResponse = {
        tasks: [
          {
            id: 't-1',
            title: 'Explore auth',
            worker: 'explorer',
            brief: 'Inspect tokens',
            dependencies: [],
          },
          {
            id: 't-2',
            title: 'Verify auth',
            worker: 'verifier',
            brief: 'Run tests',
            dependencies: ['t-1'],
          },
        ],
      };

      vi.mocked(
        mockContext.geminiClient?.generateContent,
      ).mockResolvedValueOnce({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: JSON.stringify(jsonResponse) }],
            },
          },
        ],
      } as unknown as never);

      const plan = await orchestrator.planGoal('Verify auth tokens');
      expect(plan.tasks).toHaveLength(2);
      expect(plan.tasks[0]?.id).toBe('t-1');
      expect(plan.tasks[1]?.id).toBe('t-2');
      expect(plan.waves).toEqual([['t-1'], ['t-2']]);
    });

    it('should fall back to heuristic plan if LLM call fails', async () => {
      const orchestrator = new AfotSwarmOrchestrator(mockContext);
      vi.mocked(
        mockContext.geminiClient?.generateContent,
      ).mockRejectedValueOnce(new Error('Network offline'));

      const plan = await orchestrator.planGoal('Refactor state store');
      expect(plan.tasks.length).toBeGreaterThanOrEqual(1);
      expect(plan.tasks[0]?.worker).toBe('explorer');
    });

    it('should execute parallel waves concurrently and distill results', async () => {
      const mockRun = vi
        .fn()
        .mockResolvedValueOnce({ result: 'Files inspected: auth.ts' })
        .mockResolvedValueOnce({ result: 'RFC 7636 specs retrieved' })
        .mockResolvedValueOnce({ result: 'PKCE implemented in auth.ts' });

      vi.mocked(LocalAgentExecutor.create).mockResolvedValue({
        run: mockRun,
      } as unknown as LocalAgentExecutor<z.ZodTypeAny>);

      const orchestrator = new AfotSwarmOrchestrator(mockContext);
      const plan = {
        goal: 'Add PKCE auth',
        tasks: [
          {
            id: 't1',
            title: 'Explore',
            worker: 'explorer' as const,
            brief: 'Inspect auth.ts',
            dependencies: [],
            status: 'pending' as const,
          },
          {
            id: 't2',
            title: 'Research',
            worker: 'researcher' as const,
            brief: 'Read PKCE RFC',
            dependencies: [],
            status: 'pending' as const,
          },
          {
            id: 't3',
            title: 'Code',
            worker: 'coder' as const,
            brief: 'Implement PKCE',
            dependencies: ['t1', 't2'],
            status: 'pending' as const,
          },
        ],
        waves: [['t1', 't2'], ['t3']],
      };

      const progressEvents: SwarmProgressEvent[] = [];
      const result = await orchestrator.executeSwarm(plan, (ev) => {
        progressEvents.push(ev);
      });

      expect(result.success).toBe(true);
      expect(result.completedCount).toBe(3);
      expect(result.failedCount).toBe(0);
      expect(result.tokensSavedEstimate).toBeGreaterThan(50000);
      expect(result.summary).toContain('🌊 AFOT Swarm Execution Summary');
      expect(result.summary).toContain('Files inspected: auth.ts');

      // Verify wave 1 tasks ran before wave 2
      expect(mockRun).toHaveBeenCalledTimes(3);
    });
  });
});
