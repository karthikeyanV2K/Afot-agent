/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { Config } from '../config/config.js';
import type { LocalAgentDefinition, SubagentActivityEvent } from './types.js';
import { LocalAgentExecutor } from './local-executor.js';
import { SwarmResearcherAgent } from './swarm-researcher.js';
import { SwarmExplorerAgent } from './swarm-explorer.js';
import { SwarmCoderAgent } from './swarm-coder.js';
import { SwarmVerifierAgent } from './swarm-verifier.js';
import { GeneralistAgent } from './generalist-agent.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { getResponseText } from '../utils/partUtils.js';
import { debugLogger } from '../utils/debugLogger.js';

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

function isSwarmWorkerType(val: unknown): val is SwarmWorkerType {
  return (
    typeof val === 'string' &&
    ['researcher', 'explorer', 'coder', 'verifier', 'generalist'].includes(val)
  );
}

export type SwarmWorkerType =
  | 'researcher'
  | 'explorer'
  | 'coder'
  | 'verifier'
  | 'generalist';

export type SwarmTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface SwarmTask {
  id: string;
  title: string;
  worker: SwarmWorkerType;
  brief: string;
  dependencies: string[];
  status: SwarmTaskStatus;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface SwarmPlan {
  goal: string;
  tasks: SwarmTask[];
  waves: string[][];
}

export type SwarmProgressEventType =
  | 'plan_generated'
  | 'wave_start'
  | 'task_start'
  | 'task_progress'
  | 'task_complete'
  | 'task_failed'
  | 'swarm_complete';

export interface SwarmProgressEvent {
  type: SwarmProgressEventType;
  plan?: SwarmPlan;
  waveIndex?: number;
  taskId?: string;
  worker?: SwarmWorkerType;
  title?: string;
  brief?: string;
  detail?: string;
  output?: string;
  error?: string;
  durationMs?: number;
  totalDurationMs?: number;
  tokensSavedEstimate?: number;
}

export interface SwarmResult {
  goal: string;
  plan: SwarmPlan;
  tasks: SwarmTask[];
  summary: string;
  success: boolean;
  totalDurationMs: number;
  tokensSavedEstimate: number;
  completedCount: number;
  failedCount: number;
}

/**
 * Calculates parallel execution waves (levels) using Kahn's topological sort.
 * Tasks in each wave have all dependencies satisfied by prior waves and can execute concurrently.
 */
export function calculateWaves(tasks: SwarmTask[]): string[][] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const task of tasks) {
    inDegree.set(
      task.id,
      task.dependencies.filter((d) => taskMap.has(d)).length,
    );
    children.set(task.id, []);
  }

  for (const task of tasks) {
    for (const depId of task.dependencies) {
      if (taskMap.has(depId)) {
        children.get(depId)?.push(task.id);
      }
    }
  }

  const waves: string[][] = [];
  let currentWave = tasks
    .filter((t) => inDegree.get(t.id) === 0)
    .map((t) => t.id);

  const visited = new Set<string>();

  while (currentWave.length > 0) {
    waves.push(currentWave);
    currentWave.forEach((id) => visited.add(id));

    const nextWave: string[] = [];
    for (const id of currentWave) {
      for (const childId of children.get(id) || []) {
        inDegree.set(childId, (inDegree.get(childId) ?? 1) - 1);
        if (
          inDegree.get(childId) === 0 &&
          !visited.has(childId) &&
          !nextWave.includes(childId)
        ) {
          nextWave.push(childId);
        }
      }
    }
    currentWave = nextWave;
  }

  // Handle any remaining unvisited tasks (cycles or disconnected nodes)
  if (visited.size < tasks.length) {
    const unvisited = tasks.filter((t) => !visited.has(t.id)).map((t) => t.id);
    if (unvisited.length > 0) {
      waves.push(unvisited);
    }
  }

  return waves;
}

/**
 * Resolves a worker archetype to its corresponding LocalAgentDefinition.
 */
 
export function getSwarmAgentDefinition(
  worker: SwarmWorkerType,
  config: Config,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): LocalAgentDefinition<any> {
  switch (worker) {
    case 'researcher':
      return SwarmResearcherAgent(config);
    case 'explorer':
      return SwarmExplorerAgent(config);
    case 'coder':
      return SwarmCoderAgent(config);
    case 'verifier':
      return SwarmVerifierAgent(config);
    case 'generalist':
    default:
      return GeneralistAgent(config);
  }
}

/**
 * Generates an intelligent, deterministic fallback DAG plan based on goal semantics.
 */
export function generateHeuristicPlan(goal: string): SwarmPlan {
  const lower = goal.toLowerCase();
  const tasks: SwarmTask[] = [];

  const isResearch =
    lower.includes('research') ||
    lower.includes('search') ||
    lower.includes('how to') ||
    lower.includes('documentation') ||
    lower.includes('latest') ||
    lower.includes('docs');

  const isTestOrVerify =
    lower.includes('test') ||
    lower.includes('verify') ||
    lower.includes('lint') ||
    lower.includes('check');

  const isImplementation =
    lower.includes('implement') ||
    lower.includes('create') ||
    lower.includes('fix') ||
    lower.includes('refactor') ||
    lower.includes('build') ||
    lower.includes('add') ||
    lower.includes('update');

  if (isResearch && !isImplementation) {
    tasks.push({
      id: 'task-1',
      title: 'Web and Technical Research',
      worker: 'researcher',
      brief: `Research specifications, documentation, and technical approaches for: ${goal}`,
      dependencies: [],
      status: 'pending',
    });
  } else if (isTestOrVerify && !isImplementation) {
    tasks.push(
      {
        id: 'task-1',
        title: 'Inspect Test and Source Files',
        worker: 'explorer',
        brief: `Locate test files and verification configurations for: ${goal}`,
        dependencies: [],
        status: 'pending',
      },
      {
        id: 'task-2',
        title: 'Run Tests and Verification Checks',
        worker: 'verifier',
        brief: `Execute targeted tests, linters, or build commands to verify: ${goal}`,
        dependencies: ['task-1'],
        status: 'pending',
      },
    );
  } else if (isResearch && isImplementation) {
    // Parallel Wave 1: Researcher & Explorer work at the same time!
    tasks.push(
      {
        id: 'task-1',
        title: 'External Documentation & Specs Research',
        worker: 'researcher',
        brief: `Search web documentation and API references for: ${goal}`,
        dependencies: [],
        status: 'pending',
      },
      {
        id: 'task-2',
        title: 'Codebase Structure and File Mapping',
        worker: 'explorer',
        brief: `Explore codebase to identify relevant files, interfaces, and call sites for: ${goal}`,
        dependencies: [],
        status: 'pending',
      },
      {
        id: 'task-3',
        title: 'Implement Code Changes',
        worker: 'coder',
        brief: `Apply surgical code modifications according to research and exploration findings for: ${goal}`,
        dependencies: ['task-1', 'task-2'],
        status: 'pending',
      },
      {
        id: 'task-4',
        title: 'Verify Changes & Run Tests',
        worker: 'verifier',
        brief: `Run relevant unit tests, build checks, and verify functionality for: ${goal}`,
        dependencies: ['task-3'],
        status: 'pending',
      },
    );
  } else {
    // Default Engineering Pipeline: Explore -> Code -> Verify
    tasks.push(
      {
        id: 'task-1',
        title: 'Explore Architecture and Target Files',
        worker: 'explorer',
        brief: `Inspect codebase to identify files and code paths needed for: ${goal}`,
        dependencies: [],
        status: 'pending',
      },
      {
        id: 'task-2',
        title: 'Implement Target Modifications',
        worker: 'coder',
        brief: `Make precision code modifications for: ${goal}`,
        dependencies: ['task-1'],
        status: 'pending',
      },
      {
        id: 'task-3',
        title: 'Verify Implementation with Tests',
        worker: 'verifier',
        brief: `Run tests and linters to verify changes for: ${goal}`,
        dependencies: ['task-2'],
        status: 'pending',
      },
    );
  }

  const waves = calculateWaves(tasks);
  return { goal, tasks, waves };
}

/**
 * AFOT Swarm Orchestrator Engine.
 * Decomposes complex tasks into a DAG of specialized worker agents, executes them
 * concurrently in parallel waves, and distills outputs with zero context pollution.
 */
export class AfotSwarmOrchestrator {
  constructor(private readonly context: AgentLoopContext) {}

  /**
   * Plans the goal into a token-efficient DAG of tasks.
   */
  async planGoal(goal: string, signal?: AbortSignal): Promise<SwarmPlan> {
    const prompt = `Decompose this engineering goal into a Directed Acyclic Graph (DAG) of 2 to 5 parallelizable subtasks for an autonomous agent swarm.

Goal: "${goal}"

Available worker archetypes:
- "researcher": Fast web search and external technical docs (web_search, web_fetch).
- "explorer": Read-only codebase search, file discovery, symbol mapping (read_file, glob, grep, ls).
- "coder": Targeted code modification and file edits (read_file, edit, write_file).
- "verifier": Shell test runner, build validation, and lint verification (shell, read_file).
- "generalist": Broad cross-functional tasks.

Rules:
1. Maximize concurrency: tasks that do not depend on each other MUST have empty dependencies [] so they execute simultaneously in parallel.
2. Keep briefs concise and under 50 words.
3. Return ONLY a valid JSON object matching this structure:
{
  "tasks": [
    {
      "id": "task-1",
      "title": "Short title",
      "worker": "explorer",
      "brief": "Specific bounded assignment",
      "dependencies": []
    }
  ]
}`;

    try {
      if (this.context.geminiClient) {
        const contents = [{ role: 'user', parts: [{ text: prompt }] }];
        const response = await this.context.geminiClient.generateContent(
          { model: 'default' },
          contents,
          signal ?? new AbortController().signal,
          LlmRole.MAIN,
        );

        const text = getResponseText(response);
        if (text) {
          const jsonMatch = text.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
          if (jsonMatch) {
            const parsed: unknown = JSON.parse(jsonMatch[0]);
            if (
              isRecord(parsed) &&
              Array.isArray(parsed['tasks']) &&
              parsed['tasks'].length > 0
            ) {
              const validatedTasks: SwarmTask[] = [];
              for (const [idx, raw] of parsed['tasks'].entries()) {
                if (!isRecord(raw)) continue;
                const id = String(raw['id'] || `task-${idx + 1}`);
                const title = String(raw['title'] || `Task ${idx + 1}`);
                const workerRaw = String(
                  raw['worker'] || 'explorer',
                ).toLowerCase();
                const worker: SwarmWorkerType = isSwarmWorkerType(workerRaw)
                  ? workerRaw
                  : 'explorer';
                const brief = String(raw['brief'] || title);
                const deps = Array.isArray(raw['dependencies'])
                  ? (raw['dependencies'] as unknown[]).map(String)
                  : [];

                validatedTasks.push({
                  id,
                  title,
                  worker,
                  brief,
                  dependencies: deps,
                  status: 'pending',
                });
              }

              // Duplicate ids would collide in the task map; make them unique.
              const seen = new Set<string>();
              for (const t of validatedTasks) {
                let id = t.id;
                let n = 2;
                while (seen.has(id)) id = `${t.id}-${n++}`;
                seen.add(id);
                t.id = id;
              }
              const waves = calculateWaves(validatedTasks);
              return { goal, tasks: validatedTasks, waves };
            }
          }
        }
      }
    } catch (err) {
      debugLogger.debug(
        '[AfotSwarmOrchestrator] LLM plan generation failed, falling back to heuristic planner:',
        err,
      );
    }

    return generateHeuristicPlan(goal);
  }

  /**
   * Executes a SwarmPlan wave-by-wave, running independent tasks concurrently in parallel.
   */
  async executeSwarm(
    plan: SwarmPlan,
    onProgress?: (event: SwarmProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<SwarmResult> {
    const startTime = Date.now();
    const taskMap = new Map<string, SwarmTask>(
      plan.tasks.map((t) => [t.id, t]),
    );
    const completedOutputs = new Map<string, string>();

    onProgress?.({
      type: 'plan_generated',
      plan,
    });

    for (let waveIdx = 0; waveIdx < plan.waves.length; waveIdx++) {
      if (signal?.aborted) break;

      const waveTaskIds = plan.waves[waveIdx];
      onProgress?.({
        type: 'wave_start',
        waveIndex: waveIdx + 1,
      });

      // Find runnable tasks in this wave
      const runnableTasks: SwarmTask[] = [];
      for (const taskId of waveTaskIds) {
        const task = taskMap.get(taskId);
        if (!task) continue;

        // Check that every upstream dependency actually completed. A dependency
        // that is still pending means a cycle (calculateWaves lumps cyclic tasks
        // into one wave), which must not be run with unsatisfied inputs.
        const hasFailedDep = task.dependencies.some((depId) => {
          const dep = taskMap.get(depId);
          return !!dep && dep.status !== 'completed';
        });

        if (hasFailedDep) {
          task.status = 'skipped';
          task.error =
            'Skipped because an upstream dependency failed or could not be satisfied (cycle?).';
          onProgress?.({
            type: 'task_failed',
            taskId: task.id,
            worker: task.worker,
            title: task.title,
            error: task.error,
          });
          continue;
        }

        runnableTasks.push(task);
      }

      if (runnableTasks.length === 0) continue;

      // Execute the wave in parallel — except `coder` tasks, which write files
      // and have no file-level locking: they run one after another so two
      // workers can never edit the same file concurrently.
      const runTask = async (task: SwarmTask): Promise<void> => {
        if (signal?.aborted) {
          task.status = 'failed';
          task.error = 'Aborted by user signal.';
          return;
        }

        task.status = 'running';
        onProgress?.({
          type: 'task_start',
          taskId: task.id,
          worker: task.worker,
          title: task.title,
          brief: task.brief,
        });

        const taskStart = Date.now();
        try {
          const output = await this.executeWorkerTask(
            task,
            plan.goal,
            completedOutputs,
            signal,
            onProgress,
          );
          task.status = 'completed';
          task.output = output;
          task.durationMs = Date.now() - taskStart;
          completedOutputs.set(task.id, output);

          onProgress?.({
            type: 'task_complete',
            taskId: task.id,
            worker: task.worker,
            title: task.title,
            output,
            durationMs: task.durationMs,
          });
        } catch (err: unknown) {
          task.status = 'failed';
          task.error = err instanceof Error ? err.message : String(err);
          task.durationMs = Date.now() - taskStart;

          onProgress?.({
            type: 'task_failed',
            taskId: task.id,
            worker: task.worker,
            title: task.title,
            error: task.error,
            durationMs: task.durationMs,
          });
        }
      };

      const writers = runnableTasks.filter((t) => t.worker === 'coder');
      const others = runnableTasks.filter((t) => t.worker !== 'coder');
      await Promise.all([
        ...others.map(runTask),
        (async () => {
          for (const writer of writers) await runTask(writer);
        })(),
      ]);
    }

    const totalDurationMs = Date.now() - startTime;
    const completedCount = plan.tasks.filter(
      (t) => t.status === 'completed',
    ).length;
    const failedCount = plan.tasks.filter(
      (t) => t.status === 'failed' || t.status === 'skipped',
    ).length;
    const isSuccess = completedCount > 0 && failedCount === 0;

    // NOTE: this is a rough, assumption-based estimate (not a measurement):
    // it assumes ~25,000 tokens per task for a monolithic session and ~1,800
    // for a pruned worker. Treat the number as an order of magnitude only.
    const monolithicTokens = plan.tasks.length * 25000;
    const swarmTokens = plan.tasks.length * 1800;
    const tokensSavedEstimate = Math.max(0, monolithicTokens - swarmTokens);

    const summary = this.buildDistilledSummary(
      plan,
      totalDurationMs,
      tokensSavedEstimate,
    );

    const result: SwarmResult = {
      goal: plan.goal,
      plan,
      tasks: plan.tasks,
      summary,
      success: isSuccess,
      totalDurationMs,
      tokensSavedEstimate,
      completedCount,
      failedCount,
    };

    onProgress?.({
      type: 'swarm_complete',
      totalDurationMs,
      tokensSavedEstimate,
      output: summary,
    });

    return result;
  }

  /**
   * Plans and executes a goal in one step.
   */
  async runGoal(
    goal: string,
    onProgress?: (event: SwarmProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<SwarmResult> {
    const plan = await this.planGoal(goal, signal);
    return this.executeSwarm(plan, onProgress, signal);
  }

  /**
   * Dispatches an individual worker task with an isolated executor and context hygiene.
   */
  private async executeWorkerTask(
    task: SwarmTask,
    goal: string,
    completedOutputs: Map<string, string>,
    signal?: AbortSignal,
    onProgress?: (event: SwarmProgressEvent) => void,
  ): Promise<string> {
    const config = this.context.config;
    const registry = config.getAgentRegistry();
    const agentName = `swarm_${task.worker}`;

    const regDef = registry?.getDefinition(agentName);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const localDef: LocalAgentDefinition<any> =
      regDef && regDef.kind === 'local'
        ? regDef
        : getSwarmAgentDefinition(task.worker, config);

    const upstreamContext = task.dependencies
      .map((depId) => {
        const out = completedOutputs.get(depId);
        return out ? `[Result from ${depId}]:\n${out}` : '';
      })
      .filter(Boolean)
      .join('\n\n');

    const activityCallback = (activity: SubagentActivityEvent) => {
      if (activity.type === 'THOUGHT_CHUNK') {
        const text = String(activity.data['text'] ?? '');
        onProgress?.({
          type: 'task_progress',
          taskId: task.id,
          worker: task.worker,
          title: task.title,
          detail: text,
        });
      }
    };

    const executor = await LocalAgentExecutor.create(
      localDef,
      this.context,
      activityCallback,
    );

    const abortSignal = signal ?? new AbortController().signal;
    const executionResult = await executor.run(
      {
        task: task.brief,
        context: upstreamContext || `Goal: ${goal}`,
        objective: task.brief,
        request: task.brief,
      },
      abortSignal,
    );

    return executionResult.result || 'Task completed successfully.';
  }

  /**
   * Builds a synthesized map-reduce markdown report of the swarm's accomplishments.
   */
  private buildDistilledSummary(
    plan: SwarmPlan,
    totalDurationMs: number,
    tokensSavedEstimate: number,
  ): string {
    const durationSec = (totalDurationMs / 1000).toFixed(1);
    const lines: string[] = [
      `## 🌊 AFOT Swarm Execution Summary`,
      `**Goal:** ${plan.goal}`,
      `**Duration:** ${durationSec}s | **Waves:** ${plan.waves.length} | **Rough Token Savings (assumption-based estimate):** ~${tokensSavedEstimate.toLocaleString()} tokens`,
      '',
      `### ⚡ Parallel Tasks Executed:`,
    ];

    for (const task of plan.tasks) {
      const statusIcon =
        task.status === 'completed'
          ? '✅'
          : task.status === 'failed'
            ? '❌'
            : '⏭️';
      lines.push(
        `- ${statusIcon} **[${task.worker}]** ${task.title} (${((task.durationMs ?? 0) / 1000).toFixed(1)}s)`,
      );
      if (task.output) {
        lines.push(`  > ${task.output.trim().split('\n').join('\n  > ')}`);
      } else if (task.error) {
        lines.push(`  > *Error:* ${task.error}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
