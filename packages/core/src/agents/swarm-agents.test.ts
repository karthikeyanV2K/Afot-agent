/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SwarmResearcherAgent } from './swarm-researcher.js';
import { SwarmExplorerAgent } from './swarm-explorer.js';
import { SwarmCoderAgent } from './swarm-coder.js';
import { SwarmVerifierAgent } from './swarm-verifier.js';
import {
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../tools/tool-names.js';
import type { Config } from '../config/config.js';

describe('Swarm Worker Archetypes', () => {
  const fakeConfig = {} as Config;

  describe('SwarmResearcherAgent', () => {
    it('should configure pre-pruned research tools and compact settings', () => {
      const agent = SwarmResearcherAgent(fakeConfig);
      expect(agent.name).toBe('swarm_researcher');
      expect(agent.kind).toBe('local');
      expect(agent.toolConfig?.tools).toEqual([
        WEB_SEARCH_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
      ]);
      expect(agent.runConfig.maxTurns).toBe(6);
      expect(agent.includeExtensionContext).toBe(false);

      const processed = agent.processOutput?.({
        summary: 'OAuth PKCE is required for public clients.',
        sources: ['https://oauth.net/2/pkce/'],
      });
      expect(processed).toContain('OAuth PKCE is required for public clients.');
      expect(processed).toContain('https://oauth.net/2/pkce/');
    });
  });

  describe('SwarmExplorerAgent', () => {
    it('should configure read-only codebase tools', () => {
      const agent = SwarmExplorerAgent(fakeConfig);
      expect(agent.name).toBe('swarm_explorer');
      expect(agent.kind).toBe('local');
      expect(agent.toolConfig?.tools).toEqual([
        READ_FILE_TOOL_NAME,
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        LS_TOOL_NAME,
      ]);
      expect(agent.runConfig.maxTurns).toBe(8);
      expect(agent.includeExtensionContext).toBe(false);

      const processed = agent.processOutput?.({
        summary: 'Found auth controllers and routes.',
        relevantFiles: ['src/auth/login.ts', 'src/auth/session.ts'],
        keyFindings: 'loginHandler function at line 42',
      });
      expect(processed).toContain('Found auth controllers and routes.');
      expect(processed).toContain('`src/auth/login.ts`');
      expect(processed).toContain('loginHandler function at line 42');
    });
  });

  describe('SwarmCoderAgent', () => {
    it('should configure surgical code modification tools', () => {
      const agent = SwarmCoderAgent(fakeConfig);
      expect(agent.name).toBe('swarm_coder');
      expect(agent.kind).toBe('local');
      expect(agent.toolConfig?.tools).toEqual([
        READ_FILE_TOOL_NAME,
        EDIT_TOOL_NAME,
        WRITE_FILE_TOOL_NAME,
      ]);
      expect(agent.runConfig.maxTurns).toBe(10);
      expect(agent.includeExtensionContext).toBe(false);

      const processed = agent.processOutput?.({
        summary: 'Updated verifyToken logic.',
        modifiedFiles: ['src/auth/session.ts'],
      });
      expect(processed).toContain('Updated verifyToken logic.');
      expect(processed).toContain('`src/auth/session.ts`');
    });
  });

  describe('SwarmVerifierAgent', () => {
    it('should configure test verification tools', () => {
      const agent = SwarmVerifierAgent(fakeConfig);
      expect(agent.name).toBe('swarm_verifier');
      expect(agent.kind).toBe('local');
      expect(agent.toolConfig?.tools).toEqual([
        SHELL_TOOL_NAME,
        READ_FILE_TOOL_NAME,
      ]);
      expect(agent.runConfig.maxTurns).toBe(8);
      expect(agent.includeExtensionContext).toBe(false);

      const passProcessed = agent.processOutput?.({
        success: true,
        summary: 'All 15 tests passed.',
        commandOutputs: 'PASS src/auth/session.test.ts',
      });
      expect(passProcessed).toContain('✅ PASSED');
      expect(passProcessed).toContain('All 15 tests passed.');
      expect(passProcessed).toContain('PASS src/auth/session.test.ts');

      const failProcessed = agent.processOutput?.({
        success: false,
        summary: '1 test failed with timeout.',
        commandOutputs: 'FAIL src/auth/session.test.ts',
      });
      expect(failProcessed).toContain('❌ FAILED');
      expect(failProcessed).toContain('1 test failed with timeout.');
    });
  });
});
