/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { generateHeuristicPlan, shortenTitle } from './afotSwarmOrchestrator.js';

describe('generateHeuristicPlan - rust rewrite', () => {
  it('produces a multi-wave plan for "rewrite to rust"', () => {
    const plan = generateHeuristicPlan('rewrite this project to rust');
    expect(plan.title).toBeTruthy();
    expect(plan.tasks.length).toBeGreaterThanOrEqual(4);
    expect(plan.waves.length).toBeGreaterThanOrEqual(3);
    // Should have explorer, coder, verifier tasks
    const workers = plan.tasks.map((t) => t.worker).sort();
    expect(workers).toContain('coder');
    expect(workers).toContain('explorer');
    expect(workers).toContain('verifier');
  });

  it('produces a plan with dependencies for "rewrite to rust with tests"', () => {
    const plan = generateHeuristicPlan('rewrite the parser to rust with tests');
    const impl = plan.tasks.find((t) => t.worker === 'coder');
    expect(impl?.dependencies.length).toBeGreaterThan(0);
  });
});

describe('shortenTitle', () => {
  it('handles rust rewrite titles', () => {
    expect(shortenTitle('rewrite the parser to rust')).toBe('rewrite the parser to rust');
    expect(shortenTitle('rewrite this entire codebase to rust with tests')).toBe(
      'rewrite this entire codebase to rust',
    );
  });
});