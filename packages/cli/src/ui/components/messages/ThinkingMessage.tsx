/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ThoughtSummary } from '@google/gemini-cli-core';
import { theme } from '../../semantic-colors.js';
import { normalizeEscapedNewlines } from '../../utils/textUtils.js';

interface ThinkingMessageProps {
  thought: ThoughtSummary;
  terminalWidth: number;
  isFirstThinking?: boolean;
  durationMs?: number;
}

const THINKING_LEFT_PADDING = 1;

function formatDuration(durationMs?: number): string | undefined {
  if (durationMs === undefined || durationMs === null || isNaN(durationMs)) {
    return undefined;
  }
  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}m ${secs}s`;
}

function normalizeThoughtLines(thought: ThoughtSummary): string[] {
  const subject = normalizeEscapedNewlines(thought.subject || '').trim();
  const description = normalizeEscapedNewlines(thought.description || '').trim();

  const isNoise = (text: string) => {
    const trimmed = text.trim();
    return !trimmed || /^\.+$/.test(trimmed);
  };

  const lines: string[] = [];

  if (subject && !isNoise(subject)) {
    if (!description || !description.includes(subject)) {
      lines.push(subject);
    }
  }

  if (description) {
    const descriptionLines = description
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !isNoise(line));
    lines.push(...descriptionLines);
  }

  return lines;
}

/**
 * Renders a model's thought as a distinct bubble.
 * Leverages Ink layout for wrapping and borders.
 */
export const ThinkingMessage: React.FC<ThinkingMessageProps> = ({
  thought,
  terminalWidth,
  isFirstThinking,
  durationMs,
}) => {
  const fullLines = useMemo(() => normalizeThoughtLines(thought), [thought]);
  const durationStr = useMemo(() => formatDuration(durationMs), [durationMs]);

  if (fullLines.length === 0) {
    return null;
  }

  // Modern AFOT / AGY CLI style with duration header
  if (durationStr) {
    return (
      <Box width={terminalWidth} flexDirection="column">
        <Box flexDirection="row">
          <Text color="#d97706" bold>
            - Thought
          </Text>
          <Text color={theme.text.secondary}> · {durationStr}</Text>
        </Box>

        <Box
          marginLeft={THINKING_LEFT_PADDING}
          paddingLeft={1}
          borderStyle="single"
          borderLeft={true}
          borderRight={false}
          borderTop={false}
          borderBottom={false}
          borderColor={theme.text.secondary}
          flexDirection="column"
        >
          <Text> </Text>
          {fullLines.map((line, index) => {
            if (!line.trim()) {
              return <Text key={`thought-line-${index}`}> </Text>;
            }
            return (
              <Text
                key={`thought-line-${index}`}
                color={theme.text.secondary}
              >
                {line}
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  // Fallback style for legacy snapshots when no duration is specified
  return (
    <Box width={terminalWidth} flexDirection="column">
      {isFirstThinking && (
        <Text color={theme.text.primary} italic>
          {' '}
          Thinking...{' '}
        </Text>
      )}

      <Box
        marginLeft={THINKING_LEFT_PADDING}
        paddingLeft={1}
        borderStyle="single"
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor={theme.text.secondary}
        flexDirection="column"
      >
        <Text> </Text>
        {fullLines.length > 0 && (
          <Text color={theme.text.primary} bold italic>
            {fullLines[0]}
          </Text>
        )}
        {fullLines.slice(1).map((line, index) => (
          <Text key={`body-line-${index}`} color={theme.text.secondary} italic>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
};
