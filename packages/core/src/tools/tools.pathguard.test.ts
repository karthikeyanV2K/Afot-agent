/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BaseToolInvocation, type ToolResult } from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { initPathGuard } from '../core/afotPathGuard.js';

class ProbeInvocation extends BaseToolInvocation<object, ToolResult> {
  getDescription() {
    return 'probe';
  }
  async execute(): Promise<ToolResult> {
    return { llmContent: '', returnDisplay: '' };
  }
  check(target: string) {
    return this.checkPathPermission(
      target,
      'read',
      new AbortController().signal,
    );
  }
}

describe('BaseToolInvocation.checkPathPermission (AFOT path guard)', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'afot-tools-root-')),
    );
    outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'afot-tools-out-')),
    );
    vi.stubEnv('AFOT_HOME', path.join(root, '.afot-state'));
    vi.stubEnv('AFOT_PATH_GUARD', ''); // enable the guard (test-setup disables it)
    initPathGuard(root);
  });

  it('allows paths inside the session root', async () => {
    const inv = new ProbeInvocation(
      {},
      undefined as unknown as MessageBus,
      'read_file',
    );
    await expect(inv.check(path.join(root, 'a.ts'))).resolves.toBeUndefined();
  });

  it('fails closed outside the session root when there is no message bus', async () => {
    const inv = new ProbeInvocation(
      {},
      undefined as unknown as MessageBus,
      'read_file',
    );
    await expect(inv.check(path.join(outside, 'secret'))).rejects.toThrow(
      /denied/,
    );
  });

  it('fails closed when the message bus is incomplete', async () => {
    const inv = new ProbeInvocation(
      {},
      {} as unknown as MessageBus,
      'read_file',
    );
    await expect(inv.check(path.join(outside, 'secret'))).rejects.toThrow(
      /denied/,
    );
  });

  it('can be explicitly disabled with AFOT_PATH_GUARD=off', async () => {
    vi.stubEnv('AFOT_PATH_GUARD', 'off');
    const inv = new ProbeInvocation(
      {},
      undefined as unknown as MessageBus,
      'read_file',
    );
    await expect(
      inv.check(path.join(outside, 'secret')),
    ).resolves.toBeUndefined();
  });
});
