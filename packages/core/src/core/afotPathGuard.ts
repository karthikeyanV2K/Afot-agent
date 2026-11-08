/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AFOT Path Guard — session-directory permission sandbox.
 *
 * Rules (mirrors OpenCode's permission model):
 *   - Every file read/write/shell tool is restricted to the session working
 *     directory (process.cwd() at startup) by default.
 *   - If a requested path is outside that root:
 *       • Check the in-memory allow-list first (Allow Once or Allow Always).
 *       • If not in allow-list → emit a PERMISSION_REQUEST on the MessageBus
 *         and wait for the user to respond: Allow Once / Allow Always / Deny.
 *       • Allow Always persists to ~/.afot/path-grants.json so it survives
 *         across sessions.
 *   - "Allow Once" → stored for the lifetime of this process only.
 *   - "Allow Always" → written to disk, loaded back on next start.
 *   - Local providers (ollama, lmstudio) and web tools are exempt.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveToRealPath, isSubpath } from '../utils/paths.js';
import { debugLogger } from '../utils/debugLogger.js';
import { getAfotDir } from './afotAuthStorage.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PathGrantScope = 'once' | 'always';

export interface PathGrant {
  /** The real (resolved) allowed path prefix */
  realPath: string;
  scope: PathGrantScope;
  grantedAt: number; // epoch ms
}

/** Persisted on-disk grant record */
interface PersistedGrants {
  grants: PathGrant[];
}

// ─── Singleton state ──────────────────────────────────────────────────────────

/** The session root — set once at startup and never changes. */
let _sessionRoot: string = process.cwd();

/** In-memory grants (both 'once' and loaded 'always' grants). */
const _grants: PathGrant[] = [];

let _initialized = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

function getGrantsFilePath(): string {
  return path.join(getAfotDir(), 'path-grants.json');
}

/**
 * Must be called once at startup (from gemini.tsx / loadCliConfig).
 * Loads persisted 'always' grants from disk.
 */
export function initPathGuard(sessionRoot?: string): void {
  if (_initialized) return;
  _initialized = true;

  _sessionRoot = sessionRoot
    ? resolveToRealPath(sessionRoot)
    : resolveToRealPath(process.cwd());

  // Load persisted always-grants
  const grantsPath = getGrantsFilePath();
  try {
    const raw = fs.readFileSync(grantsPath, 'utf8');
    const data = JSON.parse(raw) as PersistedGrants;
    if (Array.isArray(data.grants)) {
      for (const g of data.grants) {
        if (g.realPath && g.scope === 'always') {
          _grants.push(g);
        }
      }
      debugLogger.log(
        `AFOT PathGuard: loaded ${_grants.length} persisted path grants`,
      );
    }
  } catch {
    // ENOENT is fine — no grants yet
  }
}

function persistAlwaysGrants(): void {
  const grantsPath = getGrantsFilePath();
  const always = _grants.filter((g) => g.scope === 'always');
  try {
    fs.writeFileSync(
      grantsPath,
      JSON.stringify({ grants: always } satisfies PersistedGrants, null, 2) +
        '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch (err) {
    debugLogger.warn(`AFOT PathGuard: failed to persist grants: ${err}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns the current session root (resolved). */
export function getSessionRoot(): string {
  if (!_initialized) initPathGuard();
  return _sessionRoot;
}

/**
 * Returns true if `targetPath` is inside the session root OR already granted.
 * This is a synchronous, non-prompting check — use it to skip the prompt when
 * a tool already has permission.
 */
export function isPathAllowed(targetPath: string): boolean {
  if (!_initialized) initPathGuard();

  let real: string;
  try {
    real = resolveToRealPath(targetPath);
  } catch {
    // Path doesn't exist yet — resolve against cwd
    real = path.resolve(targetPath);
  }

  // Always allow inside session root
  if (isSubpath(_sessionRoot, real)) return true;

  // Check grants
  for (const grant of _grants) {
    if (isSubpath(grant.realPath, real)) return true;
  }

  return false;
}

/**
 * Adds a grant for a path. Called after the user approves.
 * 'always' grants are persisted to disk.
 */
export function grantPath(grantPath: string, scope: PathGrantScope): void {
  if (!_initialized) initPathGuard();

  let real: string;
  try {
    real = resolveToRealPath(grantPath);
  } catch {
    real = path.resolve(grantPath);
  }

  // Avoid duplicates
  const exists = _grants.find(
    (g) => g.realPath === real && g.scope === scope,
  );
  if (!exists) {
    _grants.push({ realPath: real, scope, grantedAt: Date.now() });
    debugLogger.log(
      `AFOT PathGuard: granted "${real}" (${scope})`,
    );
  }

  if (scope === 'always') {
    persistAlwaysGrants();
  }
}

/**
 * Revokes all grants for a path (both once and always).
 */
export function revokePath(targetPath: string): void {
  let real: string;
  try {
    real = resolveToRealPath(targetPath);
  } catch {
    real = path.resolve(targetPath);
  }
  const before = _grants.length;
  _grants.splice(
    0,
    _grants.length,
    ..._grants.filter((g) => g.realPath !== real),
  );
  if (_grants.length !== before) persistAlwaysGrants();
}

/** Returns all current active grants (for display in /permissions command). */
export function listGrants(): ReadonlyArray<PathGrant> {
  return _grants;
}

/**
 * Clears all in-memory 'once' grants (called on /clear or session reset).
 * 'always' grants are preserved.
 */
export function clearOnceGrants(): void {
  const keep = _grants.filter((g) => g.scope === 'always');
  _grants.splice(0, _grants.length, ...keep);
}

/**
 * Extracts the top-level path to request a grant for.
 * For a file path like /home/user/projects/foo/bar.ts it returns /home/user/projects/foo
 * (the immediate parent directory) so the grant is useful for all files in that dir.
 */
export function normalizeGrantTarget(targetPath: string): string {
  try {
    const real = resolveToRealPath(targetPath);
    const stat = fs.statSync(real);
    return stat.isDirectory() ? real : path.dirname(real);
  } catch {
    // Path may not exist yet (write_file creating new file)
    return path.dirname(path.resolve(targetPath));
  }
}
