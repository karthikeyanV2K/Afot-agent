/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@google/gemini-cli-core';
import { validateAfotAuth } from '@google/gemini-cli-core';
import { loadEnvironment, loadSettings } from './settings.js';

export async function validateAuthMethod(
  authMethod: string,
): Promise<string | null> {
  loadEnvironment(loadSettings().merged, process.cwd());

  if (authMethod === AuthType.COMPUTE_ADC) {
    return null;
  }

  if (authMethod === AuthType.GATEWAY) {
    // Gateway validity is checked by the ACP layer; nothing to validate here
    return null;
  }

  if (authMethod === AuthType.AFOT_AUTH) {
    return validateAfotAuth();
  }

  return 'Invalid auth method selected.';
}
