/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AFOT Plugin Loader
 *
 * Loads JS/ESM plugin files from ~/.afot/plugins/ and from paths listed in
 * ~/.afot/config.json "plugins" array.
 *
 * Plugin API is compatible with the OpenCode plugin format:
 *
 *   export const MyPlugin = async ({ client }) => ({
 *     tool: {
 *       myTool: {
 *         description: "...",
 *         args: { arg: { type: "string", description: "..." } },
 *         async execute({ arg }, { sessionID }) { return "result"; }
 *       }
 *     },
 *     event: async ({ event }) => { ... }
 *   });
 *
 * Tools registered by plugins are exposed to the LLM as native tools.
 * Events fired: "session.idle" (emitted between turns when the agent is waiting).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { debugLogger } from '../utils/debugLogger.js';
import { getAfotDir, readAfotConfig } from './afotAuthStorage.js';

// ─── Types (OpenCode-compatible) ─────────────────────────────────────────────

export interface PluginToolArg {
  type: 'string' | 'number' | 'boolean';
  description: string;
  enum?: string[];
  default?: unknown;
}

export interface PluginTool {
  description: string;
  args: Record<string, PluginToolArg>;
  execute: (
    args: Record<string, unknown>,
    ctx: { sessionID: string },
  ) => Promise<string>;
}

export interface PluginEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface PluginInstance {
  tool?: Record<string, PluginTool>;
  event?: (payload: { event: PluginEvent }) => Promise<void>;
}

export interface AfotPlugin {
  /** File path this plugin was loaded from */
  filePath: string;
  /** Plugin name (export name or filename) */
  name: string;
  instance: PluginInstance;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const _loaded: AfotPlugin[] = [];
let _loadAttempted = false;

export function getLoadedPlugins(): ReadonlyArray<AfotPlugin> {
  return _loaded;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

function getPluginsDir(): string {
  return path.join(getAfotDir(), 'plugins');
}

function collectPluginPaths(): string[] {
  const paths: string[] = [];

  // 1. All .js files in ~/.afot/plugins/
  const pluginsDir = getPluginsDir();
  if (fs.existsSync(pluginsDir)) {
    for (const file of fs.readdirSync(pluginsDir)) {
      if (file.endsWith('.js') || file.endsWith('.mjs')) {
        paths.push(path.join(pluginsDir, file));
      }
    }
  }

  // 2. Paths listed in config.json "plugins"
  const config = readAfotConfig();
  if (Array.isArray(config?.plugins)) {
    for (const p of config.plugins) {
      if (typeof p === 'string' && p.trim()) {
        const resolved = path.isAbsolute(p)
          ? p
          : path.join(getAfotDir(), p);
        if (!paths.includes(resolved)) {
          paths.push(resolved);
        }
      }
    }
  }

  return paths;
}

/**
 * Minimal client proxy passed to each plugin factory function.
 * Matches the OpenCode plugin client API surface we need.
 */
function makePluginClient(sessionID: string) {
  return {
    app: {
      log: (level: string, message: string) => {
        debugLogger.log(`[plugin][${level}] ${message}`);
      },
    },
    session: {
      prompt: async (opts: {
        path: { id: string };
        body: { parts: Array<{ type: string; text: string }> };
      }) => {
        // This would normally inject a message into the session turn loop.
        // For now we log it; the agent loop will pick it up via event emission.
        debugLogger.log(
          `[plugin] session.prompt for ${opts.path.id}: ${opts.body.parts
            .map((p) => p.text)
            .join(' ')}`,
        );
      },
    },
    _sessionID: sessionID,
  };
}

/**
 * Loads all plugins. Safe to call multiple times — subsequent calls are no-ops.
 * Called once at startup from loadCliConfig.
 */
export async function loadAfotPlugins(sessionID: string = ''): Promise<void> {
  if (_loadAttempted) return;
  _loadAttempted = true;

  const pluginPaths = collectPluginPaths();
  if (pluginPaths.length === 0) return;

  const client = makePluginClient(sessionID);

  for (const filePath of pluginPaths) {
    try {
      if (!fs.existsSync(filePath)) {
        debugLogger.warn(`AFOT Plugin: file not found: ${filePath}`);
        continue;
      }

      const fileUrl = pathToFileURL(filePath).href;
      // Dynamic import — must be ESM
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mod = await import(fileUrl);

      // Find the first exported async factory function
      let factory: ((ctx: { client: typeof client }) => Promise<PluginInstance>) | null = null;
      let pluginName = path.basename(filePath, path.extname(filePath));

      for (const [exportName, exportVal] of Object.entries(mod)) {
        if (typeof exportVal === 'function') {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          factory = exportVal as (ctx: { client: typeof client }) => Promise<PluginInstance>;
          pluginName = exportName;
          break;
        }
      }

      if (!factory) {
        debugLogger.warn(
          `AFOT Plugin: no exported factory function in ${filePath}`,
        );
        continue;
      }

      const instance = await factory({ client });

      _loaded.push({ filePath, name: pluginName, instance });
      debugLogger.log(
        `AFOT Plugin: loaded "${pluginName}" from ${filePath}` +
          (instance.tool
            ? ` (tools: ${Object.keys(instance.tool).join(', ')})`
            : ''),
      );
    } catch (err) {
      debugLogger.error(`AFOT Plugin: failed to load ${filePath}: ${err}`);
    }
  }
}

/**
 * Emits a plugin event to all loaded plugins that have an event handler.
 */
export async function emitPluginEvent(event: PluginEvent): Promise<void> {
  for (const plugin of _loaded) {
    if (plugin.instance.event) {
      try {
        await plugin.instance.event({ event });
      } catch (err) {
        debugLogger.warn(
          `AFOT Plugin "${plugin.name}" event error: ${err}`,
        );
      }
    }
  }
}

/**
 * Returns all tools registered by loaded plugins, formatted for tool registration.
 */
export function getPluginTools(): Array<{
  pluginName: string;
  toolName: string;
  tool: PluginTool;
}> {
  const result: Array<{
    pluginName: string;
    toolName: string;
    tool: PluginTool;
  }> = [];
  for (const plugin of _loaded) {
    if (plugin.instance.tool) {
      for (const [toolName, tool] of Object.entries(plugin.instance.tool)) {
        result.push({ pluginName: plugin.name, toolName, tool });
      }
    }
  }
  return result;
}
