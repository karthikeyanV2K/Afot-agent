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
import { PolicyDecision, ApprovalMode } from './types.js';
import { commandMentionsAfotDir } from './afotStateDirGuard.js';
import {
  appendAuditEntry,
  getAuditLogPath,
  redactCommand,
  resetAuditDedupe,
} from '../core/afotAudit.js';
import {
  hasAfotPermissionConfigDrifted,
  isAfotAutoApproveEnabled,
  resetAfotRuntimePermissions,
  setAfotPermissions,
} from '../core/afotAuthStorage.js';

let home: string;
const cfg = () => path.join(home, 'config.json');
const writeCfg = (o: object) => fs.writeFileSync(cfg(), JSON.stringify(o));
const readAudit = () =>
  fs
    .readFileSync(getAuditLogPath(), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, string>);
const shell = (command: string) => ({
  name: 'run_shell_command',
  args: { command },
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'afot-hard-'));
  vi.stubEnv('AFOT_HOME', home);
  vi.stubEnv('AFOT_AUTO_APPROVE', '');
  vi.stubEnv('AFOT_AUDIT', '');
  resetAfotRuntimePermissions();
  resetAuditDedupe();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetAfotRuntimePermissions();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('commandMentionsAfotDir', () => {
  const dir = '/home/u/.afot';
  it.each([
    'cat /home/u/.afot/auth.json',
    'cat ~/.afot/config.json',
    'cat $HOME/.afot/auth.json',
    'cat ${HOME}/.afot/auth.json',
    'type %USERPROFILE%\\.afot\\auth.json',
    'cd ~ && cat .afot/auth.json',
    'echo $AFOT_HOME',
    'sed -i s/x/y/ "/HOME/U/.AFOT/config.json"',
  ])('flags %s', (c) => {
    expect(commandMentionsAfotDir(c, dir, '/home/u')).toBe(true);
  });
  it.each([
    'cargo test',
    'ls -la',
    'cat notafot/file',
    'echo afot',
    'git log --oneline',
    'cat my.afotx',
  ])('allows %s', (c) => {
    expect(commandMentionsAfotDir(c, dir, '/home/u')).toBe(false);
  });
});

describe('YOLO still prompts for ~/.afot', () => {
  const yolo = () =>
    new PolicyEngine({
      defaultDecision: PolicyDecision.ASK_USER,
      approvalMode: ApprovalMode.YOLO,
      rules: [],
    });

  it('asks when a shell command touches the state dir', async () => {
    vi.stubEnv('AFOT_AUTO_APPROVE', '1');
    const r = await yolo().check(shell(`cat ${home}/auth.json`), undefined);
    expect(r.decision).toBe(PolicyDecision.ASK_USER);
    expect(readAudit()[0]).toMatchObject({ event: 'forced_ask' });
  });

  it('becomes DENY in non-interactive mode', async () => {
    vi.stubEnv('AFOT_AUTO_APPROVE', '1');
    const e = new PolicyEngine({
      defaultDecision: PolicyDecision.ASK_USER,
      approvalMode: ApprovalMode.YOLO,
      nonInteractive: true,
      rules: [],
    });
    const r = await e.check(shell(`cat ${home}/config.json`), undefined);
    expect(r.decision).toBe(PolicyDecision.DENY);
  });

  it('does not affect ordinary commands, which are audited', async () => {
    vi.stubEnv('AFOT_AUTO_APPROVE', '1');
    const r = await yolo().check(shell('cargo test'), undefined);
    expect(r.decision).toBe(PolicyDecision.ALLOW);
    expect(readAudit()[0]).toMatchObject({
      event: 'auto_approved',
      command: 'cargo test',
    });
  });
});

describe('audit log', () => {
  it('writes JSONL with 0600 and redacts secrets', () => {
    appendAuditEntry({
      event: 'auto_approved',
      command:
        'curl -H "Authorization: Bearer abcdef123456789" https://u:pw@h/x --token=hunter2 sk-abcdefghijklmnop1234',
      mode: 'yolo',
    });
    const raw = fs.readFileSync(getAuditLogPath(), 'utf8');
    expect(raw).not.toContain('abcdef123456789');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('pw@');
    expect(raw).not.toContain('sk-abcdefghijklmnop1234');
    expect(raw).toContain('[REDACTED]');
    if (process.platform !== 'win32') {
      expect(fs.statSync(getAuditLogPath()).mode & 0o777).toBe(0o600);
    }
  });

  it('truncates long commands and collapses whitespace', () => {
    const out = redactCommand('a\n\n  b ' + 'x'.repeat(900));
    expect(out.startsWith('a b ')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(501);
  });

  it('dedupes identical entries within a second', () => {
    const e = { event: 'auto_approved', command: 'ls', mode: 'm' } as const;
    appendAuditEntry(e, 1000);
    appendAuditEntry(e, 1500);
    appendAuditEntry(e, 3000);
    expect(readAudit()).toHaveLength(2);
  });

  it('can be disabled and never throws on write failure', () => {
    vi.stubEnv('AFOT_AUDIT', '0');
    appendAuditEntry({ event: 'auto_approved', command: 'ls', mode: 'm' });
    expect(fs.existsSync(getAuditLogPath())).toBe(false);
    vi.stubEnv('AFOT_AUDIT', '');
    const blocker = path.join(home, 'blocker');
    fs.writeFileSync(blocker, 'x');
    vi.stubEnv('AFOT_HOME', path.join(blocker, 'sub')); // ENOTDIR
    expect(() =>
      appendAuditEntry({ event: 'auto_approved', command: 'ls', mode: 'm' }),
    ).not.toThrow();
  });

  it('rotates past 5 MB', () => {
    fs.writeFileSync(getAuditLogPath(), 'x'.repeat(5 * 1024 * 1024 + 1));
    appendAuditEntry({ event: 'auto_approved', command: 'ls', mode: 'm' });
    expect(fs.existsSync(getAuditLogPath() + '.1')).toBe(true);
    expect(readAudit()).toHaveLength(1);
  });
});

describe('permission snapshot', () => {
  it('ignores config.json edits made after the first read', () => {
    writeCfg({ autoApprove: false });
    expect(isAfotAutoApproveEnabled()).toBe(false);
    writeCfg({ autoApprove: true }); // a tool/injection edits the file
    expect(isAfotAutoApproveEnabled()).toBe(false);
    expect(hasAfotPermissionConfigDrifted()).toBe(true);
  });

  it("applies the user's own permission changes immediately", () => {
    writeCfg({ autoApprove: false });
    expect(isAfotAutoApproveEnabled()).toBe(false);
    setAfotPermissions({ autoApprove: true });
    expect(isAfotAutoApproveEnabled()).toBe(true);
    expect(hasAfotPermissionConfigDrifted()).toBe(false);
  });

  it('env flags stay live', () => {
    writeCfg({});
    expect(isAfotAutoApproveEnabled()).toBe(false);
    vi.stubEnv('AFOT_AUTO_APPROVE', '1');
    expect(isAfotAutoApproveEnabled()).toBe(true);
  });
});
