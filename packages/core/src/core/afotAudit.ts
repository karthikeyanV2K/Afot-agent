/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAfotDir } from './afotAuthStorage.js';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Append-only JSONL audit trail of shell commands that ran WITHOUT a user
 * prompt (auto-approved), plus commands forced back to a prompt because they
 * touch the AFOT state directory. Best-effort: never throws, never blocks.
 * Disable with AFOT_AUDIT=0.
 */

export interface AuditEntry {
  event: 'auto_approved' | 'forced_ask';
  command: string;
  cwd?: string;
  mode: string;
  reason?: string;
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_COMMAND = 500;

export function getAuditLogPath(): string {
  return path.join(getAfotDir(), 'audit.log');
}

export function isAuditEnabled(): boolean {
  const v = process.env['AFOT_AUDIT']?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

const REDACTIONS: Array<[RegExp, string]> = [
  [
    /\b(sk|pk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{12,}/g,
    '[REDACTED]',
  ],
  [/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [
    /((?:--?)?(?:token|password|passwd|secret|api[-_]?key|apikey|auth)[A-Za-z_-]*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    '$1[REDACTED]',
  ],
  [/(\/\/[^/\s:@]+:)[^@\s/]+(@)/g, '$1[REDACTED]$2'],
];

/** Masks common credential shapes so the log itself is not a secret store. */
export function redactCommand(command: string): string {
  let out = command;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_COMMAND ? out.slice(0, MAX_COMMAND) + '…' : out;
}

let last = { key: '', at: 0 };

export function appendAuditEntry(
  entry: AuditEntry,
  now: number = Date.now(),
): void {
  if (!isAuditEnabled()) return;
  try {
    const command = redactCommand(entry.command);
    const key = `${entry.event}|${entry.cwd ?? ''}|${command}`;
    if (key === last.key && now - last.at < 1000) return; // duplicate check() calls
    last = { key, at: now };

    const file = getAuditLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch {
      // no file yet
    }
    const line =
      JSON.stringify({
        ts: new Date(now).toISOString(),
        ...entry,
        command,
      }) + '\n';
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch (e) {
    debugLogger.log(`AFOT audit write failed: ${e}`);
  }
}

/** Test helper. */
export function resetAuditDedupe(): void {
  last = { key: '', at: 0 };
}
