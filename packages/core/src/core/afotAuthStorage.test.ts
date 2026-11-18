/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  atomicWriteFile,
  setAfotProviderKey,
  isEcoModeActive,
  isAfotFailoverEnabled,
  isAfotEmbeddedToolParsingEnabled,
  isAfotPluginsEnabled,
  readAfotAuthFile,
} from './afotAuthStorage.js';

vi.mock('../utils/debugLogger.js', () => ({
  debugLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('afotAuthStorage hardening', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'afot-auth-test-'));
    vi.stubEnv('AFOT_HOME', home);
    vi.stubEnv('AFOT_FAILOVER', '');
    vi.stubEnv('AFOT_PLUGINS', '');
    vi.stubEnv('AFOT_EMBEDDED_TOOL_CALLS', '');
    vi.stubEnv('AFOT_ECO_MODE', '');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('atomicWriteFile', () => {
    it('creates new files as 0600 and leaves no temp files behind', () => {
      const target = path.join(home, 'x.json');
      atomicWriteFile(target, '{"a":1}');
      expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual(
        [],
      );
    });

    it('preserves the mode of an existing file when none is given', () => {
      const target = path.join(home, 'other-tool.json');
      fs.writeFileSync(target, '{}', { mode: 0o640 });
      fs.chmodSync(target, 0o640);
      atomicWriteFile(target, '{"b":2}');
      expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    });

    it('tightens a file that was created with looser permissions', () => {
      const target = path.join(home, 'auth.json');
      fs.writeFileSync(target, '{}', { mode: 0o666 });
      fs.chmodSync(target, 0o666);
      atomicWriteFile(target, '{}', 0o600);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    });
  });

  describe('setAfotProviderKey', () => {
    it('keeps existing keys when adding a new one', () => {
      setAfotProviderKey('openrouter', 'sk-or-v1-aaa');
      setAfotProviderKey('nvidia', 'nvapi-bbb');
      const auth = readAfotAuthFile();
      expect(auth?.['openrouter']).toEqual({
        type: 'api',
        key: 'sk-or-v1-aaa',
      });
      expect(auth?.['nvidia']).toEqual({ type: 'api', key: 'nvapi-bbb' });
    });

    it('refuses to overwrite a corrupt auth.json (would wipe every stored key)', () => {
      const authPath = path.join(home, 'auth.json');
      fs.writeFileSync(
        authPath,
        '{ "openrouter": { "type": "api", "key": "sk-or-',
        {
          mode: 0o600,
        },
      );
      expect(() => setAfotProviderKey('nvidia', 'nvapi-new')).toThrow();
      expect(fs.readFileSync(authPath, 'utf8')).toContain('sk-or-');
    });
  });

  describe('isEcoModeActive', () => {
    it('is on for -free / :free models and the opencode provider', () => {
      expect(isEcoModeActive(null, 'openrouter', 'nvidia/nemotron:free')).toBe(
        true,
      );
      expect(isEcoModeActive(null, 'nvidia', 'glm-5.3-flash-free')).toBe(true);
      expect(isEcoModeActive(null, 'opencode', 'anything')).toBe(true);
    });

    it('does not match models that merely contain the letters "free"', () => {
      expect(isEcoModeActive(null, 'openrouter', 'acme/freeform-70b')).toBe(
        false,
      );
    });
  });

  describe('safety flags', () => {
    it('defaults: failover off, plugins off, embedded tool parsing on', () => {
      expect(isAfotFailoverEnabled(null)).toBe(false);
      expect(isAfotPluginsEnabled(null)).toBe(false);
      expect(isAfotEmbeddedToolParsingEnabled(null)).toBe(true);
    });

    it('honours config values and env overrides (env wins)', () => {
      expect(isAfotFailoverEnabled({ failover: true })).toBe(true);
      expect(isAfotPluginsEnabled({ pluginsEnabled: true })).toBe(true);
      expect(
        isAfotEmbeddedToolParsingEnabled({ embeddedToolCalls: false }),
      ).toBe(false);

      vi.stubEnv('AFOT_FAILOVER', '0');
      expect(isAfotFailoverEnabled({ failover: true })).toBe(false);
      vi.stubEnv('AFOT_PLUGINS', '1');
      expect(isAfotPluginsEnabled(null)).toBe(true);
    });
  });
});
