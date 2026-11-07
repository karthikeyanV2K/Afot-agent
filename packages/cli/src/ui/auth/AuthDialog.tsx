/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import {
  SettingScope,
  type LoadableSettingScope,
  type LoadedSettings,
} from '../../config/settings.js';
import {
  AuthType,
  type Config,
  listAfotProviders,
  resolveAfotProvider,
} from '@google/gemini-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { AuthState } from '../types.js';
import { validateAuthMethodWithSettings } from './useAuth.js';
import { ProviderConnectDialog } from './ProviderConnectDialog.js';

interface AuthDialogProps {
  config: Config;
  settings: LoadedSettings;
  setAuthState: (state: AuthState) => void;
  authError: string | null;
  onAuthError: (error: string | null) => void;
  setAuthContext: (context: { requiresRestart?: boolean }) => void;
}

export function AuthDialog({
  config: _config,
  settings,
  setAuthState,
  authError,
  onAuthError,
  setAuthContext,
}: AuthDialogProps): React.JSX.Element {
  // ── ALL hooks must be declared unconditionally at the top ─────────────────
  const [afotProviders, setAfotProviders] = useState<string[]>([]);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);

  // Load provider info on mount — jump straight to connect if nothing configured
  useEffect(() => {
    const providers = listAfotProviders();
    setAfotProviders(providers);
    const resolved = resolveAfotProvider();
    if (resolved) setActiveProvider(resolved.name);
    if (providers.length === 0) setShowConnect(true);
  }, []);

  const handleConnected = useCallback(
    (providerName: string) => {
      setActiveProvider(providerName);
      setAfotProviders(listAfotProviders());
      setShowConnect(false);
      onAuthError(null);
      settings.setValue(
        SettingScope.User,
        'security.auth.selectedType',
        AuthType.AFOT_AUTH,
      );
      setAuthContext({});
      setAuthState(AuthState.Unauthenticated);
    },
    [settings, setAuthState, onAuthError, setAuthContext],
  );

  const handleConnectClose = useCallback(() => {
    if (afotProviders.length === 0) {
      onAuthError(
        'You must connect at least one provider to proceed. Press Ctrl+C twice to exit.',
      );
    }
    setShowConnect(false);
  }, [afotProviders.length, onAuthError]);

  // These callbacks and keypress are needed for the "list" screen.
  // They must be declared unconditionally even when showConnect is true.
  const onSelect = useCallback(
    async (authType: AuthType | undefined, scope: LoadableSettingScope) => {
      if (authType === AuthType.AFOT_AUTH) {
        setShowConnect(true);
        return;
      }
      if (authType) {
        setAuthContext({});
        settings.setValue(scope, 'security.auth.selectedType', authType);
      }
      setAuthState(AuthState.Unauthenticated);
    },
    [settings, setAuthState, setAuthContext],
  );

  const handleAuthSelect = useCallback(
    async (authMethod: AuthType) => {
      const error = await validateAuthMethodWithSettings(
        authMethod,
        settings,
      ).catch((e) => (e instanceof Error ? e.message : String(e)));
      if (error) {
        onAuthError(error);
      } else {
        onAuthError(null);
        await onSelect(authMethod, SettingScope.User);
      }
    },
    [onSelect, onAuthError, settings],
  );

  // Keypress handler is always declared; isActive: !showConnect keeps it idle
  // while the connect dialog is open (the connect dialog handles its own keys).
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (authError) return true;
        if (settings.merged.security.auth.selectedType === undefined) {
          onAuthError(
            'You must select an auth method to proceed. Press Ctrl+C twice to exit.',
          );
          return true;
        }
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        onSelect(undefined, SettingScope.User);
        return true;
      }
      return false;
    },
    { isActive: !showConnect },
  );
  // ─────────────────────────────────────────────────────────────────────────

  // Show the OpenCode-style connect dialog (no hooks after this point)
  if (showConnect) {
    return (
      <ProviderConnectDialog
        onConnected={handleConnected}
        onClose={handleConnectClose}
      />
    );
  }

  // ── Simple selection screen (provider already configured) ─────────────────
  let items = [
    {
      label: activeProvider
        ? `AFOT Auth  (active: ${activeProvider})`
        : afotProviders.length > 0
          ? `AFOT Auth  (${afotProviders.length} provider${afotProviders.length > 1 ? 's' : ''} available)`
          : 'AFOT Auth  (press Enter to connect a provider)',
      value: AuthType.AFOT_AUTH,
      key: AuthType.AFOT_AUTH,
    },
    ...(process.env['CLOUD_SHELL'] === 'true'
      ? [
          {
            label: 'Cloud Shell credentials (ADC)',
            value: AuthType.COMPUTE_ADC,
            key: AuthType.COMPUTE_ADC,
          },
        ]
      : process.env['GEMINI_CLI_USE_COMPUTE_ADC'] === 'true'
        ? [
            {
              label: 'Metadata server application default credentials',
              value: AuthType.COMPUTE_ADC,
              key: AuthType.COMPUTE_ADC,
            },
          ]
        : []),
  ];

  if (settings.merged.security.auth.enforcedType) {
    items = items.filter(
      (item) => item.value === settings.merged.security.auth.enforcedType,
    );
  }

  const initialAuthIndex = Math.max(
    0,
    items.findIndex((item) => {
      if (settings.merged.security.auth.selectedType) {
        return item.value === settings.merged.security.auth.selectedType;
      }
      return item.value === AuthType.AFOT_AUTH;
    }),
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.ui.focus}
      flexDirection="row"
      padding={1}
      width="100%"
      alignItems="flex-start"
    >
      <Text color={theme.text.accent}>? </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color={theme.text.primary}>
          Get started
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text.primary}>
            How would you like to authenticate?
          </Text>
        </Box>
        <Box marginTop={1}>
          <RadioButtonSelect
            items={items}
            initialIndex={initialAuthIndex}
            onSelect={handleAuthSelect}
            onHighlight={() => {
              onAuthError(null);
            }}
          />
        </Box>
        {authError && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{authError}</Text>
          </Box>
        )}
        {afotProviders.length > 0 ? (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              Providers: {afotProviders.join(', ')}
            </Text>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              Press Enter to connect a provider
            </Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>(Use Enter to select)</Text>
        </Box>
      </Box>
    </Box>
  );
}
