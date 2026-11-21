/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../utils/debugLogger.js', () => ({
  debugLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('afotPathGuard', () => {
  let base: string;
  let project: string;
  let afotHome: string;

  const load = async () => {
    vi.resetModules();
    return import('./afotPathGuard.js');
  };

  beforeEach(() => {
    base = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'afot-guard-test-')),
    );
    project = path.join(base, 'project');
    afotHome = path.join(base, '.afot');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(afotHome, { recursive: true });
    fs.writeFileSync(path.join(base, 'secret.txt'), 'x');
    vi.stubEnv('AFOT_HOME', afotHome);
    vi.stubEnv('HOME', base);
    vi.stubEnv('USERPROFILE', base);
    vi.stubEnv('AFOT_PATH_GUARD', '');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('allows the session root and denies paths outside it', async () => {
    const g = await load();
    g.initPathGuard(project);
    expect(g.isPathAllowed(path.join(project, 'a.ts'))).toBe(true);
    expect(g.isPathAllowed(path.join(base, 'secret.txt'))).toBe(false);
  });

  it('protects ~/.afot even when the session root contains it', async () => {
    const g = await load();
    g.initPathGuard(base); // project lives directly under the dir that holds ~/.afot
    expect(g.isPathAllowed(path.join(base, 'secret.txt'))).toBe(true);
    expect(g.isPathAllowed(path.join(afotHome, 'auth.json'))).toBe(false);
    expect(g.isPathAllowed(path.join(afotHome, 'path-grants.json'))).toBe(
      false,
    );

    // A grant for the parent does not unlock it; one for the AFOT dir does.
    g.grantPath(base, 'once');
    expect(g.isPathAllowed(path.join(afotHome, 'auth.json'))).toBe(false);
    g.grantPath(afotHome, 'once');
    expect(g.isPathAllowed(path.join(afotHome, 'auth.json'))).toBe(true);
  });

  it('refuses to grant the filesystem root', async () => {
    const g = await load();
    g.initPathGuard(project);
    g.grantPath(path.parse(base).root, 'always');
    expect(g.listGrants()).toHaveLength(0);
    expect(g.isPathAllowed(path.join(base, 'secret.txt'))).toBe(false);
  });

  it('persists "always" grants atomically with mode 0600 and reloads them', async () => {
    let g = await load();
    g.initPathGuard(project);
    const shared = path.join(base, 'shared');
    fs.mkdirSync(shared);
    g.grantPath(shared, 'always');
    const grantsFile = path.join(afotHome, 'path-grants.json');
    if (process.platform !== 'win32') {
      expect(fs.statSync(grantsFile).mode & 0o777).toBe(0o600);
    }

    g = await load();
    g.initPathGuard(project);
    expect(g.isPathAllowed(path.join(shared, 'f.txt'))).toBe(true);
  });

  it('ignores invalid persisted grants (relative paths, filesystem root)', async () => {
    const root = path.parse(base).root;
    fs.writeFileSync(
      path.join(afotHome, 'path-grants.json'),
      JSON.stringify({
        grants: [
          { realPath: root, scope: 'always', grantedAt: 1 },
          { realPath: 'relative/dir', scope: 'always', grantedAt: 1 },
          { realPath: 42, scope: 'always', grantedAt: 1 },
        ],
      }),
      { mode: 0o600 },
    );
    const g = await load();
    g.initPathGuard(project);
    expect(g.listGrants()).toHaveLength(0);
    expect(g.isPathAllowed(path.join(base, 'secret.txt'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'ignores a grants file that is writable by group/others',
    async () => {
      const shared = path.join(base, 'shared');
      fs.mkdirSync(shared);
      const grantsFile = path.join(afotHome, 'path-grants.json');
      fs.writeFileSync(
        grantsFile,
        JSON.stringify({
          grants: [{ realPath: shared, scope: 'always', grantedAt: 1 }],
        }),
      );
      fs.chmodSync(grantsFile, 0o666);
      const g = await load();
      g.initPathGuard(project);
      expect(g.isPathAllowed(path.join(shared, 'f.txt'))).toBe(false);
    },
  );

  it('grants only the exact file when a file directly in $HOME is approved', async () => {
    const g = await load();
    g.initPathGuard(project);
    const target = path.join(base, 'secret.txt'); // base === $HOME in this test
    expect(g.normalizeGrantTarget(target)).toBe(target);
    // …but a normal project file still grants its directory
    const nested = path.join(base, 'shared', 'a.txt');
    fs.mkdirSync(path.dirname(nested));
    fs.writeFileSync(nested, 'x');
    expect(g.normalizeGrantTarget(nested)).toBe(path.dirname(nested));
  });

  it('allows all paths when setAllowAllPaths(true) is called', async () => {
    const g = await load();
    g.initPathGuard(project);
    expect(g.isPathAllowed(path.join(base, 'secret.txt'))).toBe(false);
    g.setAllowAllPaths(true);
    expect(g.isAllowAllPaths()).toBe(true);
    expect(g.isPathGuardDisabled()).toBe(true);
    expect(g.isPathAllowed(path.join(base, 'secret.txt'))).toBe(true);
    // ~/.afot credentials remain protected from accidental access even when allowAllPaths is active
    expect(g.isPathAllowed(path.join(afotHome, 'auth.json'))).toBe(false);
  });

  it('recognizes AFOT_PATH_GUARD=0, false, and disabled as disabling path guard', async () => {
    for (const val of ['0', 'false', 'disabled', 'off']) {
      vi.stubEnv('AFOT_PATH_GUARD', val);
      const g = await load();
      g.initPathGuard(project);
      expect(g.isPathGuardDisabled()).toBe(true);
      expect(g.isPathAllowed(path.join(base, 'secret.txt'))).toBe(true);
    }
  });

  it('recognizes AFOT_ALLOW_ALL_PATHS=1 as allowing all paths', async () => {
    vi.stubEnv('AFOT_ALLOW_ALL_PATHS', '1');
    const g = await load();
    g.initPathGuard(project);
    expect(g.isPathGuardDisabled()).toBe(true);
    expect(g.isPathAllowed(path.join(base, 'secret.txt'))).toBe(true);
  });

  it('loads extra paths configured via AFOT_ALLOWED_PATHS on init', async () => {
    const extraDir = path.join(base, 'extra_dir');
    fs.mkdirSync(extraDir);
    vi.stubEnv('AFOT_ALLOWED_PATHS', extraDir);
    const g = await load();
    g.initPathGuard(project);
    expect(g.isPathAllowed(path.join(extraDir, 'file.txt'))).toBe(true);
  });

  it('correctly identifies protected AFOT paths via isProtectedAfotPath', async () => {
    const g = await load();
    expect(g.isProtectedAfotPath(path.join(afotHome, 'auth.json'))).toBe(true);
    expect(g.isProtectedAfotPath(path.join(afotHome, 'path-grants.json'))).toBe(true);
    expect(g.isProtectedAfotPath(path.join(project, 'src', 'index.ts'))).toBe(false);
    expect(g.isProtectedAfotPath(path.join(base, 'secret.txt'))).toBe(false);
  });

  it('allows access across paths when autoApprove is active in runtime permissions', async () => {
    const { setAfotRuntimePermissions, resetAfotRuntimePermissions } = await import('./afotAuthStorage.js');
    setAfotRuntimePermissions({ autoApprove: true });
    try {
      const g = await load();
      g.initPathGuard(project);
      expect(g.isPathGuardDisabled()).toBe(true);
      expect(g.isPathAllowed(path.join(base, 'secret.txt'))).toBe(true);
      expect(g.isPathAllowed(path.join(afotHome, 'auth.json'))).toBe(false);
    } finally {
      resetAfotRuntimePermissions();
    }
  });
});
