/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AfotSwarmOrchestrator,
  calculateWaves,
  type SwarmPlan,
  type SwarmTask,
} from './afotSwarmOrchestrator.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';

vi.mock('./local-executor.js', () => ({
  LocalAgentExecutor: { create: vi.fn() },
}));

const task = (
  id: string,
  worker: SwarmTask['worker'],
  dependencies: string[] = [],
): SwarmTask => ({
  id,
  title: id,
  worker,
  brief: id,
  dependencies,
  status: 'pending',
});

function makePlan(tasks: SwarmTask[]): SwarmPlan {
  return { goal: 'g', tasks, waves: calculateWaves(tasks) };
}

describe('AfotSwarmOrchestrator hardening', () => {
  it('skips tasks in a dependency cycle instead of running them with unmet inputs', async () => {
    const orch = new AfotSwarmOrchestrator({} as AgentLoopContext);
    const exec = vi
      .spyOn(
        orch as unknown as { executeWorkerTask: () => Promise<string> },
        'executeWorkerTask',
      )
      .mockResolvedValue('ok');
    const plan = makePlan([
      task('a', 'explorer', ['b']),
      task('b', 'explorer', ['a']),
      task('c', 'explorer'),
    ]);
    const result = await orch.executeSwarm(plan);
    const byId = Object.fromEntries(result.tasks.map((t) => [t.id, t.status]));
    expect(byId).toEqual({ a: 'skipped', b: 'skipped', c: 'completed' });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it('runs coder tasks of the same wave one at a time, others in parallel', async () => {
    const orch = new AfotSwarmOrchestrator({} as AgentLoopContext);
    let activeCoders = 0;
    let maxCoders = 0;
    let activeAll = 0;
    let maxAll = 0;
    vi.spyOn(
      orch as unknown as {
        executeWorkerTask: (t: SwarmTask) => Promise<string>;
      },
      'executeWorkerTask',
    ).mockImplementation(async (t: SwarmTask) => {
      activeAll++;
      maxAll = Math.max(maxAll, activeAll);
      if (t.worker === 'coder') {
        activeCoders++;
        maxCoders = Math.max(maxCoders, activeCoders);
      }
      await new Promise((r) => setTimeout(r, 15));
      if (t.worker === 'coder') activeCoders--;
      activeAll--;
      return 'done';
    });
    const plan = makePlan([
      task('c1', 'coder'),
      task('c2', 'coder'),
      task('e1', 'explorer'),
      task('e2', 'explorer'),
    ]);
    expect(plan.waves).toHaveLength(1);
    const result = await orch.executeSwarm(plan);
    expect(result.success).toBe(true);
    expect(maxCoders).toBe(1);
    expect(maxAll).toBeGreaterThan(1);
  });

  it('labels the token-savings number as a rough estimate', async () => {
    const orch = new AfotSwarmOrchestrator({} as AgentLoopContext);
    vi.spyOn(
      orch as unknown as { executeWorkerTask: () => Promise<string> },
      'executeWorkerTask',
    ).mockResolvedValue('ok');
    const result = await orch.executeSwarm(makePlan([task('a', 'explorer')]));
    expect(result.summary).toMatch(/estimate/i);
  });
});
