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

const PLUGIN_SRC = `export const Demo = async () => ({
  tool: { hello: { description: 'hi', args: {}, async execute() { return 'hello'; } } },
});
`;

describe('afotPluginLoader', () => {
  let home: string;
  let pluginsDir: string;

  const load = async () => {
    vi.resetModules();
    return import('./afotPluginLoader.js');
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'afot-plugin-test-'));
    pluginsDir = path.join(home, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.chmodSync(pluginsDir, 0o755);
    fs.writeFileSync(path.join(pluginsDir, 'demo.mjs'), PLUGIN_SRC, {
      mode: 0o644,
    });
    vi.stubEnv('AFOT_HOME', home);
    vi.stubEnv('AFOT_PLUGINS', '');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('does not execute plugins unless explicitly enabled', async () => {
    const loader = await load();
    await loader.loadAfotPlugins('s1');
    expect(loader.getLoadedPlugins()).toHaveLength(0);
  });

  it('loads plugins once "pluginsEnabled" is set', async () => {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ pluginsEnabled: true }),
    );
    const loader = await load();
    await loader.loadAfotPlugins('s1');
    expect(loader.getPluginTools().map((t) => t.toolName)).toEqual(['hello']);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses group/world-writable plugin files',
    async () => {
      fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({ pluginsEnabled: true }),
      );
      fs.chmodSync(path.join(pluginsDir, 'demo.mjs'), 0o666);
      const loader = await load();
      expect(
        loader.validatePluginFile(path.join(pluginsDir, 'demo.mjs')),
      ).toMatch(/writable/);
      await loader.loadAfotPlugins('s1');
      expect(loader.getLoadedPlugins()).toHaveLength(0);
    },
  );
});
