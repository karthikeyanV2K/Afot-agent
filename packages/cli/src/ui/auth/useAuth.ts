/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import {
  AuthType,
  type Config,
  debugLogger,
  isAccountSuspendedError,
  ProjectIdRequiredError,
  ChangeAuthRequestedError,
  ValidationCancelledError,
} from '@google/gemini-cli-core';
import { getErrorMessage } from '@google/gemini-cli-core';
import { AuthState } from '../types.js';
import { validateAuthMethod } from '../../config/auth.js';

export async function validateAuthMethodWithSettings(
  authType: AuthType,
  settings: LoadedSettings,
): Promise<string | null> {
  const enforcedType = settings.merged.security.auth.enforcedType;
  if (enforcedType && enforcedType !== authType) {
    return `Authentication is enforced to be ${enforcedType}, but you are currently using ${authType}.`;
  }
  if (settings.merged.security.auth.useExternal) {
    return null;
  }
  return validateAuthMethod(authType);
}

import type { AccountSuspensionInfo } from '../contexts/UIStateContext.js';

export const useAuthCommand = (
  settings: LoadedSettings,
  config: Config,
  initialAuthError: string | null = null,
  initialAccountSuspensionInfo: AccountSuspensionInfo | null = null,
) => {
  const [authState, setAuthState] = useState<AuthState>(
    initialAuthError ? AuthState.Updating : AuthState.Unauthenticated,
  );

  const [authError, setAuthError] = useState<string | null>(initialAuthError);
  const [accountSuspensionInfo, setAccountSuspensionInfo] =
    useState<AccountSuspensionInfo | null>(initialAccountSuspensionInfo);

  // Kept for API compatibility with consumers that destructure this field
  const [apiKeyDefaultValue] = useState<string | undefined>(undefined);

  const onAuthError = useCallback(
    (error: string | null) => {
      setAuthError(error);
      if (error) {
        setAuthState(AuthState.Updating);
      }
    },
    [setAuthError, setAuthState],
  );

  // No-op kept for API compatibility — AFOT auth doesn't use interactive key entry
  const reloadApiKey = useCallback(async () => {
    return '';
  }, []);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      if (authState !== AuthState.Unauthenticated) {
        return;
      }

      const authType = settings.merged.security.auth.selectedType;
      if (!authType) {
        onAuthError('No authentication method selected.');
        return;
      }

      const error = await validateAuthMethodWithSettings(
        authType,
        settings,
      ).catch((e: unknown) => getErrorMessage(e));

      if (error) {
        onAuthError(error);
        return;
      }

      try {
        await config.refreshAuth(authType);
        debugLogger.log(`Authenticated via "${authType}".`);
        setAuthError(null);
        setAuthState(AuthState.Authenticated);
      } catch (e) {
        if (
          e instanceof ChangeAuthRequestedError ||
          e instanceof ValidationCancelledError
        ) {
          setAuthError(null);
          setAuthState(AuthState.Updating);
          return;
        }
        const suspendedError = isAccountSuspendedError(e);
        if (suspendedError) {
          setAccountSuspensionInfo({
            message: suspendedError.message,
            appealUrl: suspendedError.appealUrl,
            appealLinkText: suspendedError.appealLinkText,
          });
        } else if (e instanceof ProjectIdRequiredError) {
          onAuthError(getErrorMessage(e));
        } else {
          onAuthError(`Failed to authenticate. Message: ${getErrorMessage(e)}`);
        }
      }
    })();
  }, [
    settings,
    config,
    authState,
    setAuthState,
    setAuthError,
    onAuthError,
  ]);

  return {
    authState,
    setAuthState,
    authError,
    onAuthError,
    apiKeyDefaultValue,
    reloadApiKey,
    accountSuspensionInfo,
    setAccountSuspensionInfo,
  };
};
