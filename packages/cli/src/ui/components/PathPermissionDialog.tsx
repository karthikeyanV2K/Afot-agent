/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { theme } from '../semantic-colors.js';
import type { PathPermissionRequest } from '@google/gemini-cli-core';

interface PathPermissionDialogProps {
  request: PathPermissionRequest;
  onDecision: (decision: 'allow_once' | 'allow_always' | 'deny') => void;
}

const opLabel: Record<string, string> = {
  read: 'read from',
  write: 'write to',
  execute: 'run commands in',
};

export function PathPermissionDialog({
  request,
  onDecision,
}: PathPermissionDialogProps): React.JSX.Element {
  const op = opLabel[request.operation] ?? request.operation;
  const items = [
    {
      label: 'Allow once  (this request only)',
      value: 'allow_once' as const,
      key: 'allow_once',
    },
    {
      label: 'Allow always  (saved — never ask again for this path)',
      value: 'allow_always' as const,
      key: 'allow_always',
    },
    {
      label: 'Deny',
      value: 'deny' as const,
      key: 'deny',
    },
  ];

  return (
    <Box
      borderStyle="round"
      borderColor={theme.status.warning}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Box marginBottom={1}>
        <Text bold color={theme.status.warning}>
          ⚠  Path outside session directory
        </Text>
      </Box>
      <Text color={theme.text.primary}>
        <Text bold>{request.toolName}</Text> wants to {op}:
      </Text>
      <Box marginTop={1} marginLeft={2}>
        <Text color={theme.text.accent}>{request.grantTarget}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          Session root is outside this path.
        </Text>
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          initialIndex={0}
          onSelect={onDecision}
        />
      </Box>
    </Box>
  );
}
