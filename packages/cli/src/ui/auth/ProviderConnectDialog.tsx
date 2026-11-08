/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenCode-style "Connect an integration" provider picker.
 *
 * Architecture mirrors OpenCode's dialog-integration.tsx + dialog-select.tsx:
 *  - Providers grouped as "Connected" (has key) / "Popular" / "Services"
 *  - Live fuzzy search filter
 *  - Selecting a provider → API key input screen
 *  - After key saved → calls onConnected(providerName)
 *
 * Auth flow (mirrors OpenCode's server-connection.ts Basic auth concept):
 *  - We store provider keys in ~/.afot/auth.json (our equivalent of OpenCode's auth.json)
 *  - key type → show TextInput, save via setAfotProviderKey()
 *  - No browser OAuth needed for current providers (all are api-key type)
 */

import type React from 'react';
import { useState, useMemo, useCallback, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  BUILTIN_PROVIDERS,
  getAllAfotProviderStatus,
  resolveAfotProvider,
  setAfotProviderKey,
  setAfotDefaultProvider,
  getOpenCodeCredential,
  requestDeviceCode,
  pollDeviceToken,
  saveOpenCodeCredential,
  OPENCODE_CONSOLE_SERVER,
  OPENCODE_PROVIDER_KEY,
  type OpenCodeDeviceCodeResponse,
} from '@google/gemini-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { useSearchBuffer } from '../hooks/useSearchBuffer.js';
import { Command } from '../key/keyMatchers.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import { useSelectionList } from '../hooks/useSelectionList.js';
import { TextInput } from '../components/shared/TextInput.js';

// ─── Provider ordering (matches OpenCode's INTEGRATION_PRIORITY) ──────────────

const POPULAR_PROVIDERS = new Set([
  'opencode', // OpenCode Console — first, like OpenCode's own dialog
  'opencode-go',
  'openai',
  'github-copilot',
  'anthropic',
  'google-ai',
  'openrouter',
  'nvidia',
  'deepseek',
  'groq',
  'mistral',
  'cline-pass',
]);

type ProviderCategory = 'Connected' | 'Popular' | 'Services' | 'Local';

interface ProviderEntry {
  key: string;
  name: string;
  baseUrl: string;
  category: ProviderCategory;
  configured: boolean;
  isLocal: boolean;
  isActive: boolean;
}

function getCategory(
  name: string,
  configured: boolean,
  isLocal: boolean,
): ProviderCategory {
  if (configured && !isLocal) return 'Connected';
  if (isLocal) return 'Local';
  if (POPULAR_PROVIDERS.has(name)) return 'Popular';
  return 'Services';
}

const CATEGORY_ORDER: ProviderCategory[] = [
  'Connected',
  'Popular',
  'Services',
  'Local',
];

function buildProviderList(activeProviderName: string | null): ProviderEntry[] {
  const statuses = getAllAfotProviderStatus();

  // Inject OpenCode Console as a special OAuth entry (may not be in BUILTIN_PROVIDERS)
  const hasOpencode = statuses.some((s) => s.name === OPENCODE_PROVIDER_KEY);
  const openCodeCred = getOpenCodeCredential();

  const entries: ProviderEntry[] = statuses.map((s) => ({
    key: s.name,
    name: formatProviderName(s.name),
    baseUrl: s.baseUrl,
    category: getCategory(s.name, s.configured || (s.name === OPENCODE_PROVIDER_KEY && !!openCodeCred), s.isLocal),
    configured: s.configured || (s.name === OPENCODE_PROVIDER_KEY && !!openCodeCred),
    isLocal: s.isLocal,
    isActive: s.name === activeProviderName,
  }));

  // Always include OpenCode Console if not already present
  if (!hasOpencode) {
    entries.push({
      key: OPENCODE_PROVIDER_KEY,
      name: 'OpenCode Console',
      baseUrl: OPENCODE_CONSOLE_SERVER,
      category: openCodeCred ? 'Connected' : 'Popular',
      configured: !!openCodeCred,
      isLocal: false,
      isActive: OPENCODE_PROVIDER_KEY === activeProviderName,
    });
  }

  // Sort: by category order, then alphabetically within category
  return entries.sort((a, b) => {
    const catA = CATEGORY_ORDER.indexOf(a.category);
    const catB = CATEGORY_ORDER.indexOf(b.category);
    if (catA !== catB) return catA - catB;
    // OpenCode Console always first within Popular
    if (a.key === OPENCODE_PROVIDER_KEY) return -1;
    if (b.key === OPENCODE_PROVIDER_KEY) return 1;
    return a.name.localeCompare(b.name);
  });
}

function formatProviderName(id: string): string {
  const map: Record<string, string> = {
    opencode: 'OpenCode Console',
    'opencode-go': 'OpenCode Go',
    openai: 'OpenAI',
    'github-copilot': 'GitHub Copilot',
    anthropic: 'Anthropic',
    'google-ai': 'Google',
    openrouter: 'OpenRouter',
    nvidia: 'NVIDIA',
    deepseek: 'DeepSeek',
    groq: 'Groq',
    mistral: 'Mistral',
    together: 'Together AI',
    xai: 'xAI',
    cohere: 'Cohere',
    perplexity: 'Perplexity',
    zai: 'Z.AI',
    'cline-pass': 'ClinePass',
    ollama: 'Ollama',
    lmstudio: 'LM Studio',
  };
  return map[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  // Simple fuzzy: all chars of query appear in order in target
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ─── Screen types ─────────────────────────────────────────────────────────────

type Screen =
  | { kind: 'list' }
  | { kind: 'key-input'; providerName: string; displayName: string; error?: string }
  | { kind: 'oauth-device'; deviceCode: OpenCodeDeviceCodeResponse; error?: string }
  | { kind: 'oauth-success'; providerName: string };

// ─── Main dialog ─────────────────────────────────────────────────────────────

interface ProviderConnectDialogProps {
  onConnected: (providerName: string) => void;
  onClose: () => void;
}

export function ProviderConnectDialog({
  onConnected,
  onClose,
}: ProviderConnectDialogProps): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [activeProviderName, setActiveProviderName] = useState<string | null>(
    () => resolveAfotProvider()?.name ?? null,
  );
  const [refresh, setRefresh] = useState(0);

  const providers = useMemo(
    () => buildProviderList(activeProviderName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeProviderName, refresh],
  );

  const handleProviderSelect = useCallback(
    (entry: ProviderEntry) => {
      if (entry.isLocal) {
        // Local providers need no key — just set as default and connect
        setAfotDefaultProvider(entry.key);
        setActiveProviderName(entry.key);
        onConnected(entry.key);
        return;
      }
      // OpenCode Console uses OAuth device flow
      if (entry.key === OPENCODE_PROVIDER_KEY) {
        // Start device flow
        requestDeviceCode(OPENCODE_CONSOLE_SERVER)
          .then((deviceCode) => {
            setScreen({ kind: 'oauth-device', deviceCode });
          })
          .catch((err) => {
            setScreen({
              kind: 'key-input',
              providerName: entry.key,
              displayName: entry.name,
              error: `Failed to start login: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        return;
      }
      setScreen({
        kind: 'key-input',
        providerName: entry.key,
        displayName: entry.name,
      });
    },
    [onConnected],
  );

  const handleKeySubmit = useCallback(
    (providerName: string, displayName: string, key: string) => {
      if (!key.trim()) {
        setScreen({
          kind: 'key-input',
          providerName,
          displayName,
          error: 'API key cannot be empty.',
        });
        return;
      }
      setAfotProviderKey(providerName, key.trim());
      setAfotDefaultProvider(providerName);
      setActiveProviderName(providerName);
      setRefresh((r) => r + 1);
      onConnected(providerName);
    },
    [onConnected],
  );

  if (screen.kind === 'key-input') {
    return (
      <ApiKeyInputScreen
        providerName={screen.providerName}
        displayName={screen.displayName}
        error={screen.error}
        onSubmit={(key) =>
          handleKeySubmit(screen.providerName, screen.displayName, key)
        }
        onBack={() => setScreen({ kind: 'list' })}
      />
    );
  }

  if (screen.kind === 'oauth-device') {
    return (
      <OAuthDeviceScreen
        deviceCode={screen.deviceCode}
        error={screen.error}
        onConnected={(providerName) => {
          setActiveProviderName(providerName);
          setRefresh((r) => r + 1);
          setScreen({ kind: 'oauth-success', providerName });
          onConnected(providerName);
        }}
        onError={(err) =>
          setScreen({ kind: 'oauth-device', deviceCode: screen.deviceCode, error: err })
        }
        onBack={() => setScreen({ kind: 'list' })}
      />
    );
  }

  if (screen.kind === 'oauth-success') {
    return (
      <Box borderStyle="round" borderColor={theme.status.success} padding={1} flexDirection="column">
        <Text color={theme.status.success} bold>✓ Connected to OpenCode Console</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>Provider: {screen.providerName}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <ProviderListScreen
      providers={providers}
      onSelect={handleProviderSelect}
      onClose={onClose}
    />
  );
}

// ─── Provider list screen ─────────────────────────────────────────────────────

const MAX_VISIBLE = 14;

function ProviderListScreen({
  providers,
  onSelect,
  onClose,
}: {
  providers: ProviderEntry[];
  onSelect: (entry: ProviderEntry) => void;
  onClose: () => void;
}): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const [searchQuery, setSearchQuery] = useState('');
  const searchBuffer = useSearchBuffer({ onChange: setSearchQuery });

  // Keep searchQuery in sync with buffer text
  useEffect(() => {
    setSearchQuery(searchBuffer.text);
  }, [searchBuffer.text]);

  const filtered = useMemo(
    () =>
      providers.filter(
        (p) =>
          fuzzyMatch(searchQuery, p.name) ||
          fuzzyMatch(searchQuery, p.key) ||
          fuzzyMatch(searchQuery, p.baseUrl),
      ),
    [providers, searchQuery],
  );

  const selectionItems = useMemo(
    () => filtered.map((p) => ({ key: p.key, value: p })),
    [filtered],
  );

  const { activeIndex } = useSelectionList({
    items: selectionItems,
    onSelect: (item) => onSelect(item),
    isFocused: true,
    showNumbers: false,
    wrapAround: true,
    priority: true,
  });

  // Scrolling
  const [scrollOffset, setScrollOffset] = useState(0);
  useEffect(() => {
    if (activeIndex < scrollOffset) setScrollOffset(activeIndex);
    else if (activeIndex >= scrollOffset + MAX_VISIBLE)
      setScrollOffset(activeIndex - MAX_VISIBLE + 1);
  }, [activeIndex, scrollOffset]);

  useKeypress(
    (key) => {
      if (keyMatchers[Command.ESCAPE](key)) {
        onClose();
        return true;
      }
      return false;
    },
    { isActive: true },
  );

  const visibleItems = filtered.slice(scrollOffset, scrollOffset + MAX_VISIBLE);

  // Group visible items by category for section headers
  const renderedRows: React.ReactNode[] = [];
  let lastCategory: ProviderCategory | null = null;
  visibleItems.forEach((entry, visIdx) => {
    const absIdx = scrollOffset + visIdx;
    const isActive = absIdx === activeIndex;

    if (entry.category !== lastCategory) {
      lastCategory = entry.category;
      renderedRows.push(
        <Box key={`cat-${entry.category}`} paddingTop={visIdx === 0 ? 0 : 1}>
          <Text color="#c084fc" bold>
            {'  '}{entry.category}
          </Text>
        </Box>,
      );
    }

    renderedRows.push(
      <ProviderRow
        key={entry.key}
        entry={entry}
        isActive={isActive}
      />,
    );
  });

  return (
    <Box
      flexDirection="column"
      paddingY={1}
      width={64}
    >
      {/* Header */}
      <Box marginBottom={1} flexDirection="row" justifyContent="space-between" width="100%">
        <Text bold color="#22c55e">
          {'  '}Connect an integration
        </Text>
        <Text color={theme.text.secondary}>esc</Text>
      </Box>

      {/* Search input */}
      <Box marginBottom={1} paddingLeft={2}>
        <TextInput
          buffer={searchBuffer}
          placeholder="Search"
          focus={true}
        />
      </Box>

      {/* Scroll up indicator */}
      {scrollOffset > 0 && (
        <Box paddingLeft={2}>
          <Text color={theme.text.secondary}>▲</Text>
        </Box>
      )}

      {/* Provider rows with category headers */}
      <Box flexDirection="column">
        {filtered.length === 0 ? (
          <Box paddingLeft={2}>
            <Text color={theme.text.secondary}>No integrations found</Text>
          </Box>
        ) : (
          renderedRows
        )}
      </Box>

      {/* Scroll down indicator */}
      {scrollOffset + MAX_VISIBLE < filtered.length && (
        <Box paddingLeft={2}>
          <Text color={theme.text.secondary}>▼</Text>
        </Box>
      )}
    </Box>
  );
}

function ProviderRow({
  entry,
  isActive,
}: {
  entry: ProviderEntry;
  isActive: boolean;
}): React.JSX.Element {
  if (isActive) {
    return (
      <Box backgroundColor="#22c55e" width="100%" flexDirection="row" justifyContent="space-between">
        <Text color="#000000" bold>
          {'  '}{entry.name}
        </Text>
        {entry.isActive && (
          <Text color="#000000" bold>
            ✓{' '}
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box width="100%" flexDirection="row" justifyContent="space-between">
      <Text color="#4ade80">
        {'  '}{entry.name}
      </Text>
      {entry.isActive && (
        <Text color="#22c55e">
          ✓{' '}
        </Text>
      )}
    </Box>
  );
}

// ─── API key input screen ─────────────────────────────────────────────────────

function ApiKeyInputScreen({
  providerName,
  displayName,
  error,
  onSubmit,
  onBack,
}: {
  providerName: string;
  displayName: string;
  error?: string;
  onSubmit: (key: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const buffer = useSearchBuffer({ onChange: (_v) => {} });

  const providerConfig = BUILTIN_PROVIDERS[providerName];

  useKeypress(
    (key) => {
      if (keyMatchers[Command.ESCAPE](key)) {
        onBack();
        return true;
      }
      if (key.name === 'return') {
        onSubmit(buffer.text);
        return true;
      }
      return false;
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.ui.focus}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      {/* Header */}
      <Box marginBottom={1} flexDirection="row">
        <Text color={theme.text.secondary}>← </Text>
        <Text bold color={theme.text.primary}>
          {displayName}
        </Text>
      </Box>

      {/* Base URL info */}
      {providerConfig?.baseUrl && (
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>{providerConfig.baseUrl}</Text>
        </Box>
      )}

      {/* API key prompt */}
      <Box marginBottom={1}>
        <Text color={theme.text.primary}>Enter API key:</Text>
      </Box>

      <Box
        borderStyle="round"
        borderColor={error ? theme.status.error : theme.ui.focus}
        paddingX={1}
        marginBottom={1}
      >
        <TextInput
          buffer={buffer}
          placeholder="sk-..."
          onSubmit={onSubmit}
          focus={true}
        />
      </Box>

      {/* Error */}
      {error && (
        <Box marginBottom={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      )}

      {/* Help text */}
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          Key saved to ~/.afot/auth.json (never committed)
        </Text>
        {providerName === 'openrouter' && (
          <Text color={theme.text.secondary}>
            Get key at: openrouter.ai/settings/keys
          </Text>
        )}
        {providerName === 'anthropic' && (
          <Text color={theme.text.secondary}>
            Get key at: console.anthropic.com/settings/keys
          </Text>
        )}
        {providerName === 'openai' && (
          <Text color={theme.text.secondary}>
            Get key at: platform.openai.com/api-keys
          </Text>
        )}
        {providerName === 'groq' && (
          <Text color={theme.text.secondary}>
            Get key at: console.groq.com/keys
          </Text>
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>Enter to save  esc to go back</Text>
      </Box>
    </Box>
  );
}

// ─── OAuth Device Flow Screen ─────────────────────────────────────────────────

function OAuthDeviceScreen({
  deviceCode,
  error,
  onConnected,
  onError,
  onBack,
}: {
  deviceCode: OpenCodeDeviceCodeResponse;
  error?: string;
  onConnected: (providerName: string) => void;
  onError: (err: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const [status, setStatus] = useState<'waiting' | 'polling' | 'done'>('waiting');
  const [secondsLeft, setSecondsLeft] = useState(deviceCode.expires_in);
  const [browserOpened, setBrowserOpened] = useState(false);

  // Auto-open browser and start polling on mount
  useEffect(() => {
    // Open browser automatically (mirrors OpenCode's behavior)
    const url = deviceCode.verification_uri_complete;
    const openCmd = process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;

    import('node:child_process').then(({ exec }) => {
      exec(openCmd, (err) => {
        if (!err) setBrowserOpened(true);
      });
    }).catch(() => {});

    setStatus('polling');
    let cancelled = false;

    // Countdown timer
    const countdown = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);

    let pollTimer: ReturnType<typeof setTimeout>;

    async function doPoll() {
      if (cancelled) return;
      try {
        const token = await pollDeviceToken(deviceCode.device_code, OPENCODE_CONSOLE_SERVER);
        if (token) {
          const cred = {
            type: 'oauth' as const,
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: Date.now() + token.expires_in * 1000,
            org_id: token.org_id ?? undefined,
            server: OPENCODE_CONSOLE_SERVER,
          };
          saveOpenCodeCredential(cred);
          clearInterval(countdown);
          setStatus('done');
          onConnected(OPENCODE_PROVIDER_KEY);
          return;
        }
        if (!cancelled) {
          pollTimer = setTimeout(doPoll, (deviceCode.interval + 1) * 1000);
        }
      } catch (err) {
        clearInterval(countdown);
        if (!cancelled) {
          onError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    pollTimer = setTimeout(doPoll, deviceCode.interval * 1000);

    return () => {
      cancelled = true;
      clearTimeout(pollTimer);
      clearInterval(countdown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useKeypress(
    (key) => {
      if (keyMatchers[Command.ESCAPE](key)) {
        onBack();
        return true;
      }
      return false;
    },
    { isActive: true },
  );

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const timeLeft = mins > 0
    ? `${mins}m ${secs}s`
    : `${secs}s`;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.ui.focus}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color={theme.text.primary}>
          OpenCode Console — Sign in
        </Text>
      </Box>

      {/* Browser status */}
      <Box marginBottom={1}>
        <Text color={browserOpened ? theme.status.success : theme.text.secondary}>
          {browserOpened
            ? '✓ Browser opened'
            : '⚠  Could not auto-open browser — visit the URL below manually:'}
        </Text>
      </Box>

      {/* URL */}
      <Box marginBottom={1} paddingLeft={2}>
        <Text color={theme.text.accent}>{deviceCode.verification_uri_complete}</Text>
      </Box>

      {/* Code */}
      <Box marginBottom={1}>
        <Text color={theme.text.primary}>
          Approve with code:{' '}
          <Text bold color={theme.text.accent}>{deviceCode.user_code}</Text>
        </Text>
      </Box>

      {/* Status */}
      <Box marginBottom={1}>
        {status === 'polling' ? (
          <Text color={theme.text.secondary}>
            ⏳ Waiting for you to approve in the browser... ({timeLeft} remaining)
          </Text>
        ) : status === 'done' ? (
          <Text color={theme.status.success}>✓ Authenticated!</Text>
        ) : (
          <Text color={theme.text.secondary}>Starting...</Text>
        )}
      </Box>

      {error && (
        <Box marginBottom={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>esc to cancel</Text>
      </Box>
    </Box>
  );
}
