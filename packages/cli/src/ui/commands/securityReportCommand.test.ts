/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '@google/gemini-cli-core';
import {
  analyzeSarifReport,
  securityReportCommand,
} from './securityReportCommand.js';
import { CommandKind, type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('securityReportCommand', () => {
  let workspace: string;
  let outsideWorkspace: string;
  let config: Config;
  let context: CommandContext;
  let readAccessError: string | null;

  beforeEach(() => {
    readAccessError = null;
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'afot-sarif-workspace-'));
    outsideWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'afot-sarif-outside-'),
    );
    const workspaceContext = {
      isPathWithinWorkspace: (target: string) =>
        target === workspace || target.startsWith(`${workspace}${path.sep}`),
    };
    config = {
      getTargetDir: () => workspace,
      getWorkspaceContext: () => workspaceContext,
      validatePathAccess: () => readAccessError,
    } as unknown as Config;
    context = createMockCommandContext({
      services: {
        agentContext: { config },
      },
    });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outsideWorkspace, { recursive: true, force: true });
  });

  it('is a built-in command that requires an explicit invocation', () => {
    expect(securityReportCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(securityReportCommand.autoExecute).toBe(false);
  });

  it('summarizes SARIF findings with location and a content digest', async () => {
    const reportPath = path.join(workspace, 'report.sarif');
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            tool: {
              driver: {
                rules: [
                  {
                    id: 'RULE-1',
                    shortDescription: { text: 'Example finding' },
                  },
                ],
              },
            },
            results: [
              {
                ruleId: 'RULE-1',
                level: 'warning',
                message: { text: 'Review this code' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'src/example.ts' },
                      region: { startLine: 12 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const result = await securityReportCommand.action!(context, 'report.sarif');
    if (!result || result.type !== 'message') {
      throw new Error('Expected a message result');
    }
    expect(result.messageType).toBe('info');
    expect(result.content).toContain('Findings: 1 (warning: 1)');
    expect(result.content).toContain('"RULE-1"');
    expect(result.content).toContain('`"src/example.ts"`:12');
    expect(result.content).toContain('SHA-256:');
    expect(result.content).toContain('no target was contacted');
  });

  it('rejects report files outside the workspace', async () => {
    fs.writeFileSync(
      path.join(outsideWorkspace, 'report.sarif'),
      JSON.stringify({ version: '2.1.0', runs: [] }),
    );

    const result = await analyzeSarifReport(
      config,
      path.join(outsideWorkspace, 'report.sarif'),
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Report file must be inside an allowed workspace.',
    });
  });

  it('honors the configured read-path guard for workspace files', async () => {
    fs.writeFileSync(
      path.join(workspace, 'report.sarif'),
      JSON.stringify({ version: '2.1.0', runs: [] }),
    );
    readAccessError = 'Read access denied by policy.';

    const result = await analyzeSarifReport(config, 'report.sarif');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Read access denied by policy.',
    });
  });

  it('uses rule severity defaults and ignores invalid result levels', async () => {
    fs.writeFileSync(
      path.join(workspace, 'report.sarif'),
      JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            tool: {
              driver: {
                rules: [
                  {
                    id: 'RULE-1',
                    defaultConfiguration: { level: 'error' },
                  },
                ],
              },
            },
            results: [
              { ruleId: 'RULE-1', message: { text: 'Default level' } },
              {
                ruleId: 'RULE-1',
                level: '**malicious**',
                message: { text: 'Invalid level' },
              },
            ],
          },
        ],
      }),
    );

    const result = await analyzeSarifReport(config, 'report.sarif');
    expect(result.content).toContain('Findings: 2 (error: 1, unspecified: 1)');
    expect(result.content).not.toContain('**malicious**');
  });

  it('enforces the report size limit while reading', async () => {
    fs.writeFileSync(
      path.join(workspace, 'large.sarif'),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    );

    const result = await analyzeSarifReport(config, 'large.sarif');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('size limit');
  });

  it('rejects non-SARIF JSON and reports invalid JSON explicitly', async () => {
    fs.writeFileSync(
      path.join(workspace, 'unsupported.json'),
      JSON.stringify({ version: '1.0', runs: [] }),
    );
    fs.writeFileSync(path.join(workspace, 'invalid.json'), '{');

    const unsupported = await analyzeSarifReport(config, 'unsupported.json');
    const invalid = await analyzeSarifReport(config, 'invalid.json');

    expect(unsupported.type).toBe('message');
    expect(invalid.type).toBe('message');
    if (unsupported.type === 'message' && invalid.type === 'message') {
      expect(unsupported.messageType).toBe('error');
      expect(unsupported.content).toContain('SARIF 2.1.0');
      expect(invalid.messageType).toBe('error');
      expect(invalid.content).toContain('not valid JSON');
    }
  });
});
