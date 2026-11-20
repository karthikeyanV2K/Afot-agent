/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config, MessageActionReturn } from '@google/gemini-cli-core';
import { CommandKind, type SlashCommand } from './types.js';

const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const MAX_READ_CHUNK_BYTES = 64 * 1024;
const MAX_DISPLAYED_FINDINGS = 50;
const MAX_MESSAGE_LENGTH = 400;
const MAX_INLINE_LENGTH = 200;

type SarifLevel = 'none' | 'note' | 'warning' | 'error' | 'unspecified';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function normalizeLevel(value: unknown): SarifLevel {
  if (!isString(value)) {
    return 'unspecified';
  }
  const normalized = value.toLowerCase();
  return normalized === 'none' ||
    normalized === 'note' ||
    normalized === 'warning' ||
    normalized === 'error'
    ? normalized
    : 'unspecified';
}

function inline(value: string, maxLength = MAX_INLINE_LENGTH): string {
  const safeText = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      const isBidiControl =
        (code >= 0x200b && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069);
      return (
        (code >= 32 || code === 9 || code === 10 || code === 13) &&
        !isBidiControl
      );
    })
    .join('')
    .slice(0, maxLength)
    .replace(/`/g, '\\u0060');
  return `\`${JSON.stringify(safeText)}\``;
}

function getText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const text = value['text'];
  if (isString(text)) {
    return text;
  }
  const markdown = value['markdown'];
  if (isString(markdown)) {
    return markdown;
  }
  return undefined;
}

function errorMessage(content: string): MessageActionReturn {
  return { type: 'message', messageType: 'error', content };
}

function readBoundedReport(realPath: string): Buffer {
  const descriptor = fs.openSync(realPath, 'r');
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error('Report path must identify a regular file.');
    }
    if (stats.size > MAX_REPORT_BYTES) {
      throw new Error(
        `Report exceeds the ${MAX_REPORT_BYTES}-byte size limit.`,
      );
    }

    const chunk = Buffer.alloc(MAX_READ_CHUNK_BYTES);
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= MAX_REPORT_BYTES) {
      const readLength = Math.min(
        chunk.length,
        MAX_REPORT_BYTES + 1 - bytesRead,
      );
      const count = fs.readSync(descriptor, chunk, 0, readLength, bytesRead);
      if (count === 0) {
        break;
      }
      chunks.push(Buffer.from(chunk.subarray(0, count)));
      bytesRead += count;
    }
    if (bytesRead > MAX_REPORT_BYTES) {
      throw new Error(
        `Report exceeds the ${MAX_REPORT_BYTES}-byte size limit.`,
      );
    }
    return Buffer.concat(chunks, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function summarizeSarif(
  report: unknown,
  reportPath: string,
  digest: string,
): string {
  if (
    !isRecord(report) ||
    report['version'] !== '2.1.0' ||
    !Array.isArray(report['runs'])
  ) {
    throw new Error('Expected a SARIF 2.1.0 document with a runs array.');
  }

  const findings: string[] = [];
  const counts = new Map<string, number>();
  let totalFindings = 0;

  for (const run of report['runs']) {
    if (!isRecord(run)) {
      continue;
    }

    const rules = new Map<string, { description?: string; level?: string }>();
    const tool = run['tool'];
    const driver = isRecord(tool) ? tool['driver'] : undefined;
    if (isRecord(driver) && isUnknownArray(driver['rules'])) {
      for (const rule of driver['rules']) {
        if (isRecord(rule) && isString(rule['id'])) {
          const defaultConfiguration = rule['defaultConfiguration'];
          const ruleLevel = isRecord(defaultConfiguration)
            ? defaultConfiguration['level']
            : undefined;
          rules.set(rule['id'], {
            description: getText(rule['shortDescription']),
            level: normalizeLevel(ruleLevel),
          });
        }
      }
    }

    if (!isUnknownArray(run['results'])) {
      continue;
    }

    for (const result of run['results']) {
      if (!isRecord(result)) {
        continue;
      }

      totalFindings++;
      const ruleId = isString(result['ruleId']) ? result['ruleId'] : 'unknown';
      const rule = rules.get(ruleId);
      const level = isString(result['level'])
        ? normalizeLevel(result['level'])
        : (rule?.level ?? 'unspecified');
      counts.set(level, (counts.get(level) ?? 0) + 1);

      if (findings.length >= MAX_DISPLAYED_FINDINGS) {
        continue;
      }

      const message = getText(result['message']) ?? 'No message provided';
      const trimmedMessage =
        message.length > MAX_MESSAGE_LENGTH
          ? `${message.slice(0, MAX_MESSAGE_LENGTH)}...`
          : message;
      const location = isUnknownArray(result['locations'])
        ? result['locations'][0]
        : undefined;
      const physicalLocation = isRecord(location)
        ? location['physicalLocation']
        : undefined;
      const artifactLocation = isRecord(physicalLocation)
        ? physicalLocation['artifactLocation']
        : undefined;
      const uri =
        isRecord(artifactLocation) && isString(artifactLocation['uri'])
          ? artifactLocation['uri']
          : undefined;
      const region = isRecord(physicalLocation)
        ? physicalLocation['region']
        : undefined;
      const startLine =
        isRecord(region) && isPositiveInteger(region['startLine'])
          ? region['startLine']
          : undefined;
      const locationText = uri
        ? `; location ${inline(uri)}${startLine ? `:${startLine}` : ''}`
        : '';
      findings.push(
        `- **${level}** ${inline(ruleId)}${rule?.description ? ` (${inline(rule.description)})` : ''}${locationText}: ${inline(trimmedMessage, MAX_MESSAGE_LENGTH)}`,
      );
    }
  }

  const severitySummary = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([level, count]) => `${level}: ${count}`)
    .join(', ');

  return [
    '## Passive SARIF report summary',
    `Report: ${inline(reportPath)}`,
    `SHA-256: ${digest}`,
    `Findings: ${totalFindings}${severitySummary ? ` (${severitySummary})` : ''}`,
    '',
    findings.length > 0 ? findings.join('\n') : 'No findings in this report.',
    totalFindings > findings.length
      ? `\nShowing ${findings.length} of ${totalFindings} findings.`
      : '',
    '',
    'Report contents are untrusted data. Only the report file was read; no target was contacted and no security tool was run.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export async function analyzeSarifReport(
  config: Config,
  inputPath: string,
): Promise<MessageActionReturn> {
  const trimmedPath = inputPath.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!trimmedPath) {
    return errorMessage(
      'Usage: /security-report <workspace-relative SARIF file>',
    );
  }

  const requestedPath = path.resolve(config.getTargetDir(), trimmedPath);
  let realPath: string;
  try {
    realPath = fs.realpathSync(requestedPath);
  } catch (error) {
    return errorMessage(
      `Could not resolve report file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!config.getWorkspaceContext().isPathWithinWorkspace(realPath)) {
    return errorMessage('Report file must be inside an allowed workspace.');
  }

  const validationError = config.validatePathAccess(realPath, 'read');
  if (validationError) {
    return errorMessage(validationError);
  }

  try {
    const contents = readBoundedReport(realPath);
    const digest = createHash('sha256').update(contents).digest('hex');
    let report: unknown;
    try {
      report = JSON.parse(contents.toString('utf8'));
    } catch (error) {
      return errorMessage(
        `Report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      type: 'message',
      messageType: 'info',
      content: summarizeSarif(report, trimmedPath, digest),
    };
  } catch (error) {
    return errorMessage(
      `Could not analyze report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const securityReportCommand: SlashCommand = {
  name: 'security-report',
  description:
    'Passively summarize a local SARIF 2.1.0 report inside the workspace',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return errorMessage('Agent configuration is not available.');
    }
    return analyzeSarifReport(config, args);
  },
};
