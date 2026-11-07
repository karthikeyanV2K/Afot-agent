/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box } from 'ink';
import { type Config } from '@google/gemini-cli-core';
import { CloudFreePrivacyNotice } from './CloudFreePrivacyNotice.js';

interface PrivacyNoticeProps {
  onExit: () => void;
  config: Config;
}

/**
 * Privacy notice — uses the generic cloud-free notice for all auth types
 * now that Google-specific auth types have been removed.
 */
export const PrivacyNotice = ({ onExit, config }: PrivacyNoticeProps) => (
  <Box borderStyle="round" padding={1} flexDirection="column">
    <CloudFreePrivacyNotice config={config} onExit={onExit} />
  </Box>
);
