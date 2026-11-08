/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useContext, useMemo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ModelQuotaDisplay } from './ModelQuotaDisplay.js';
import { useUIState } from '../contexts/UIStateContext.js';
import {
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_3_1_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  GEMINI_MODEL_ALIAS_AUTO,
  GEMMA_4_31B_IT_MODEL,
  GEMMA_4_26B_A4B_IT_MODEL,
  ModelSlashCommandEvent,
  logModelSlashCommand,
  getDisplayString,
  AuthType,
  PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL,
  isProModel,
  getAutoModelDescription,
  resolveAfotActiveProviderName,
  resolveAfotProviderByName,
  resolveOpenCodeProvider,
  fetchAfotProviderModels,
  readAfotConfig,
  setAfotDefaultProvider,
  setAfotProviderDefaultModel,
  getAfotRecentModels,
  saveAfotRecentModel,
  toggleAfotFavorite,
  OPENCODE_FREE_MODELS,
} from '@google/gemini-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import { Command } from '../key/keyMatchers.js';
import { useSearchBuffer } from '../hooks/useSearchBuffer.js';
import { useSelectionList } from '../hooks/useSelectionList.js';
import { TextInput } from './shared/TextInput.js';
import { ProviderConnectDialog } from '../auth/ProviderConnectDialog.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';

interface ModelDialogProps {
  onClose: () => void;
}

// ─── OpenCode-style Unified Model Catalog ─────────────────────────────────────

interface UnifiedModelItem {
  id: string;
  name: string;
  displayName: string;
  providerKey: string;
  providerName: string;
  section: string;
  isFree: boolean;
  isActiveModel: boolean;
}

function formatModelName(modelId: string): string {
  const base = modelId.includes('/') ? modelId.split('/')[1]! : modelId;

  const known: Record<string, string> = {
    'glm-5.3-flash': 'GLM-5.3-Flash',
    'glm-5.3-flash-free': 'GLM-5.3-Flash Free',
    'glm-5.3': 'GLM-5.3',
    'minimax-m3.1-flash': 'MiniMax-M3.1-Flash',
    'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
    'deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash Free',
    'nemotron-3.5-super-vl-free': 'Nemotron 3.5 Super VL Free',
    'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning Free',
    'crouton-alpha-free': 'Crouton Alpha Free',
    'flint-40b-free': 'Flint 40B Free',
    'iceman-free': 'Iceman Free',
    'inkling-2-small-free': 'Inkling 2 Small Free',
    'beam-free': 'Beam Free',
    'big-pickle': 'Big Pickle',
    'mimo-v2.6-flash-free': 'Mimo V2.6 Flash Free',
    'claude-fable-5-1': 'Claude Fable 5.1',
    'claude-haiku-5-5': 'Claude Haiku 5.5',
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-4-argon': 'Gemini 4 Argon',
    'gpt-5.3-codex': 'GPT 5.3 Codex',
    'gpt-5.4-mini': 'GPT 5.4 Mini',
    'gpt-5.5': 'GPT 5.5',
  };

  if (known[base.toLowerCase()]) {
    return known[base.toLowerCase()];
  }

  return base
    .split(/[-_]/)
    .map((word) => {
      if (!word) return '';
      if (/^(ai|gpt|glm|vl|v\d+(\.\d+)?|b|mb|gb|it)$/i.test(word)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function formatProviderName(id: string): string {
  const map: Record<string, string> = {
    opencode: 'OpenCode',
    nvidia: 'Nvidia',
    openrouter: 'OpenRouter',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    'google-ai': 'Google AI',
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

function isFreeModel(modelId: string, providerKey: string): boolean {
  if (modelId.toLowerCase().includes('free')) return true;
  if (providerKey === 'nvidia') return true;
  return false;
}

function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

const MAX_VISIBLE_MODELS = 11;

function AfotUnifiedModelDialog({
  onClose,
}: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const keyMatchers = useKeyMatchers();
  const [showConnect, setShowConnect] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchBuffer = useSearchBuffer({ onChange: setSearchQuery });
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [_favVersion, setFavVersion] = useState(0);
  const [liveOpencodeModels, setLiveOpencodeModels] = useState<string[]>([]);
  const [liveProviderModels, setLiveProviderModels] = useState<
    Record<string, string[]>
  >({});

  useEffect(() => {
    setSearchQuery(searchBuffer.text);
  }, [searchBuffer.text]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const op = await resolveOpenCodeProvider().catch(() => null);
        if (!cancelled && op?.models && op.models.length > 0) {
          setLiveOpencodeModels(op.models.filter(Boolean));
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeProvider = resolveAfotActiveProviderName() ?? 'opencode';
  const currentModel = config?.getModel() ?? '';

  useEffect(() => {
    let cancelled = false;
    if (activeProvider && activeProvider !== 'opencode') {
      void (async () => {
        try {
          const prov = resolveAfotProviderByName(activeProvider);
          if (prov) {
            const models = await fetchAfotProviderModels(prov);
            if (!cancelled && models.length > 0) {
              setLiveProviderModels((prev) => ({
                ...prev,
                [activeProvider]: models,
              }));
            }
          }
        } catch {
          // ignore
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [activeProvider]);

  const allItems = useMemo(() => {
    const afotConf = readAfotConfig();
    const recents = getAfotRecentModels();
    const items: UnifiedModelItem[] = [];
    const recentKeySet = new Set<string>();

    // 1. Build Recent section (only if user has actual recent models)
    for (const r of recents) {
      const name = formatModelName(r.id);
      const pName = formatProviderName(r.provider);
      const isFree = isFreeModel(r.id, r.provider);
      const isActiveModel =
        (r.id === currentModel ||
          r.id.endsWith(currentModel) ||
          currentModel.endsWith(r.id)) &&
        r.provider === activeProvider;

      items.push({
        id: r.id,
        name,
        displayName: `${name} ${pName}`,
        providerKey: r.provider,
        providerName: pName,
        section: 'Recent',
        isFree,
        isActiveModel,
      });
      recentKeySet.add(`${r.provider}:${r.id}`);
    }

    // 2. OpenCode provider section (strictly verified free models)
    const rawOpencode =
      liveOpencodeModels.length > 0
        ? liveOpencodeModels
        : (afotConf?.providers?.['opencode']?.models ?? OPENCODE_FREE_MODELS);
    const opencodeModels = rawOpencode.filter(
      (m) =>
        OPENCODE_FREE_MODELS.includes(m) ||
        m.includes('-free') ||
        m === 'big-pickle',
    );

    for (const m of opencodeModels) {
      if (recentKeySet.has(`opencode:${m}`)) continue;
      const name = formatModelName(m);
      const isFree = isFreeModel(m, 'opencode');
      const isActiveModel =
        (m === currentModel ||
          m.endsWith(currentModel) ||
          currentModel.endsWith(m)) &&
        activeProvider === 'opencode';

      items.push({
        id: m,
        name,
        displayName: name,
        providerKey: 'opencode',
        providerName: 'OpenCode',
        section: 'OpenCode',
        isFree,
        isActiveModel,
      });
    }

    // 3. Other configured providers
    if (afotConf?.providers) {
      for (const [pKey, pConfig] of Object.entries(afotConf.providers)) {
        if (pKey === 'opencode') continue;
        const providerModels =
          liveProviderModels[pKey]?.length
            ? liveProviderModels[pKey]
            : (pConfig.models ?? []);
        if (providerModels.length === 0) continue;
        const pName = formatProviderName(pKey);

        for (const m of providerModels) {
          if (recentKeySet.has(`${pKey}:${m}`)) continue;
          const name = formatModelName(m);
          const isFree = isFreeModel(m, pKey);
          const isActiveModel =
            (m === currentModel ||
              m.endsWith(currentModel) ||
              currentModel.endsWith(m)) &&
            activeProvider === pKey;

          items.push({
            id: m,
            name,
            displayName: name,
            providerKey: pKey,
            providerName: pName,
            section: pName,
            isFree,
            isActiveModel,
          });
        }
      }
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    catalogVersion,
    liveOpencodeModels,
    liveProviderModels,
    activeProvider,
    currentModel,
  ]);

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return allItems;
    return allItems.filter(
      (item) =>
        fuzzyMatch(searchQuery, item.displayName) ||
        fuzzyMatch(searchQuery, item.id) ||
        fuzzyMatch(searchQuery, item.providerName) ||
        fuzzyMatch(searchQuery, item.section),
    );
  }, [allItems, searchQuery]);

  const initialIndex = useMemo(() => {
    const idx = filteredItems.findIndex((it) => it.isActiveModel);
    return idx >= 0 ? idx : 0;
  }, [filteredItems]);

  const handleSelectModel = useCallback(
    async (item: UnifiedModelItem) => {
      const curProv = resolveAfotActiveProviderName();
      if (item.providerKey !== curProv) {
        setAfotDefaultProvider(item.providerKey);
        if (config?.refreshAuth) {
          await config.refreshAuth(AuthType.AFOT_AUTH);
        }
      }
      setAfotProviderDefaultModel(item.providerKey, item.id);
      if (config) {
        config.setModel(item.id, true);
        const event = new ModelSlashCommandEvent(item.id);
        logModelSlashCommand(config, event);
      }
      saveAfotRecentModel(item.id, item.providerKey);
      onClose();
    },
    [config, onClose],
  );

  const selectionItems = useMemo(
    () =>
      filteredItems.map((item) => ({
        key: `${item.section}:${item.providerKey}:${item.id}`,
        value: item,
      })),
    [filteredItems],
  );

  const { activeIndex } = useSelectionList({
    items: selectionItems,
    onSelect: (item) => handleSelectModel(item),
    initialIndex,
    isFocused: !showConnect,
    showNumbers: false,
    wrapAround: true,
    priority: true,
  });

  const [scrollOffset, setScrollOffset] = useState(0);
  useEffect(() => {
    if (activeIndex < scrollOffset) setScrollOffset(activeIndex);
    else if (activeIndex >= scrollOffset + MAX_VISIBLE_MODELS)
      setScrollOffset(activeIndex - MAX_VISIBLE_MODELS + 1);
  }, [activeIndex, scrollOffset]);

  useKeypress(
    (key) => {
      if (showConnect) return false;
      if (key.name === 'escape' || keyMatchers[Command.ESCAPE](key)) {
        onClose();
        return true;
      }
      if (key.ctrl && (key.name === 'a' || key.sequence === '\x01')) {
        setShowConnect(true);
        return true;
      }
      if (key.ctrl && (key.name === 'f' || key.sequence === '\x06')) {
        const cur = filteredItems[activeIndex];
        if (cur) {
          toggleAfotFavorite(cur.id);
          setFavVersion((v) => v + 1);
        }
        return true;
      }
      return false;
    },
    { isActive: !showConnect, priority: true },
  );

  if (showConnect) {
    return (
      <ProviderConnectDialog
        onConnected={(_providerName) => {
          setShowConnect(false);
          setCatalogVersion((v) => v + 1);
        }}
        onClose={() => setShowConnect(false)}
      />
    );
  }

  const visibleItems = filteredItems.slice(
    scrollOffset,
    scrollOffset + MAX_VISIBLE_MODELS,
  );

  const renderedRows: React.ReactNode[] = [];
  let lastSection: string | null = null;
  visibleItems.forEach((entry, visIdx) => {
    const absIdx = scrollOffset + visIdx;
    const isSelected = absIdx === activeIndex;

    if (entry.section !== lastSection) {
      lastSection = entry.section;
      renderedRows.push(
        <Box key={`sec-${entry.section}`} paddingTop={visIdx === 0 ? 0 : 1}>
          <Text bold color="#c084fc">
            {entry.section}
          </Text>
        </Box>,
      );
    }

    renderedRows.push(
      <ModelRow
        key={`${entry.section}:${entry.providerKey}:${entry.id}`}
        item={entry}
        isSelected={isSelected}
      />,
    );
  });

  return (
    <Box
      borderStyle="round"
      borderColor="#2e3830"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      width={68}
    >
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text bold color="#22c55e">
          Select model
        </Text>
        <Text color={theme.text.secondary}>esc</Text>
      </Box>

      {/* Search Input */}
      <Box marginBottom={1}>
        <TextInput
          buffer={searchBuffer}
          placeholder="Search"
          focus={!showConnect}
          onCancel={onClose}
        />
      </Box>

      {/* Scroll indicator up */}
      {scrollOffset > 0 && (
        <Box paddingLeft={1}>
          <Text color={theme.text.secondary}>▲</Text>
        </Box>
      )}

      {/* Rows */}
      <Box flexDirection="column">
        {filteredItems.length === 0 ? (
          <Box paddingLeft={2} paddingTop={1}>
            <Text color={theme.text.secondary}>No models found</Text>
          </Box>
        ) : (
          renderedRows
        )}
      </Box>

      {/* Scroll indicator down */}
      {scrollOffset + MAX_VISIBLE_MODELS < filteredItems.length && (
        <Box paddingLeft={1}>
          <Text color={theme.text.secondary}>▼</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} flexDirection="row">
        <Text color="#4ade80">Connect an integration </Text>
        <Text color={theme.text.secondary}>ctrl+a    </Text>
        <Text color="#4ade80">Favorite </Text>
        <Text color={theme.text.secondary}>ctrl+f</Text>
      </Box>
    </Box>
  );
}

function ModelRow({
  item,
  isSelected,
}: {
  item: UnifiedModelItem;
  isSelected: boolean;
}): React.JSX.Element {
  const bullet = item.isActiveModel ? '● ' : '  ';

  if (isSelected) {
    return (
      <Box
        backgroundColor="#22c55e"
        flexDirection="row"
        justifyContent="space-between"
        width="100%"
        paddingX={0}
      >
        <Box flexDirection="row">
          <Text color="#000000" bold>
            {bullet}
          </Text>
          <Text color="#000000" bold>
            {item.displayName}
          </Text>
        </Box>
        {item.isFree && (
          <Text color="#000000" bold>
            Free
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="row" justifyContent="space-between" width="100%">
      <Box flexDirection="row">
        <Text color={item.isActiveModel ? '#22c55e' : theme.text.secondary}>
          {bullet}
        </Text>
        <Text color="#4ade80">{item.displayName}</Text>
      </Box>
      {item.isFree && <Text color="#4ade80">Free</Text>}
    </Box>
  );
}

// ─── Legacy Model Dialog (Used for non-AFOT auth types / tests) ───────────────

function LegacyModelDialog({ onClose }: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const settings = useSettings();
  const { terminalWidth } = useUIState();
  const [hasAccessToProModel, setHasAccessToProModel] = useState<boolean>(
    () => !(config?.getProModelNoAccessSync() ?? false),
  );
  const selectedAuthType = settings.merged.security.auth.selectedType;
  const [view, setView] = useState<'main' | 'manual'>(() =>
    config?.getProModelNoAccessSync() ||
    selectedAuthType === AuthType.AFOT_AUTH
      ? 'manual'
      : 'main',
  );
  const [persistMode, setPersistMode] = useState(false);
  const [afotModels, setAfotModels] = useState<string[]>([]);
  const [afotProviderName, setAfotProviderName] = useState<string | null>(null);

  useEffect(() => {
    if (selectedAuthType !== AuthType.AFOT_AUTH) {
      setAfotModels([]);
      setAfotProviderName(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      const providerName = resolveAfotActiveProviderName();
      setAfotProviderName(providerName);
      if (!providerName) {
        if (!cancelled) setAfotModels([]);
        return;
      }

      const models =
        providerName === 'opencode'
          ? (await resolveOpenCodeProvider().catch(() => null))?.models ?? []
          : await fetchAfotProviderModels(
              resolveAfotProviderByName(providerName),
            );
      if (!cancelled) setAfotModels(models.filter(Boolean));
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedAuthType]);

  useEffect(() => {
    async function checkAccess() {
      if (!config) return;
      const noAccess = await config.getProModelNoAccess();
      setHasAccessToProModel(!noAccess);
      if (noAccess) {
        setView('manual');
      }
    }
    void checkAccess();
  }, [config]);

  const preferredModel = config?.getModel() || GEMINI_MODEL_ALIAS_AUTO;
  const shouldShowPreviewModels = config?.getHasAccessToPreviewModel() ?? false;
  const useGemini31 = config?.getGemini31LaunchedSync?.() ?? false;
  const useLatestFlash = config?.hasLatestFlashGAAccess?.() ?? false;
  const useLatestFlashLite = config?.hasLatestFlashLiteGAAccess?.() ?? false;
  const useCustomToolModel =
    useGemini31 && selectedAuthType === AuthType.AFOT_AUTH;

  const manualModelSelected = useMemo(() => {
    if (
      config?.getExperimentalDynamicModelConfiguration?.() === true &&
      config.getModelConfigService
    ) {
      const def = config
        .getModelConfigService()
        .getModelDefinition(preferredModel);
      return def && def.tier !== 'auto' && def.isVisible === true
        ? preferredModel
        : '';
    }

    const manualModels = [
      DEFAULT_GEMINI_MODEL,
      DEFAULT_GEMINI_FLASH_MODEL,
      DEFAULT_GEMINI_FLASH_LITE_MODEL,
      PREVIEW_GEMINI_MODEL,
      PREVIEW_GEMINI_3_1_MODEL,
      PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL,
      PREVIEW_GEMINI_FLASH_LITE_MODEL,
      PREVIEW_GEMINI_FLASH_MODEL,
    ].filter((m) => m !== 'none');
    if (manualModels.includes(preferredModel)) {
      return preferredModel;
    }
    return '';
  }, [preferredModel, config]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (view === 'manual' && hasAccessToProModel) {
          setView('main');
        } else {
          onClose();
        }
        return true;
      }
      if (key.name === 'tab') {
        setPersistMode((prev) => !prev);
        return true;
      }
      return false;
    },
    { isActive: true },
  );

  const mainOptions = useMemo(() => {
    if (
      config?.getExperimentalDynamicModelConfiguration?.() === true &&
      config.getModelConfigService
    ) {
      const allOptions = config
        .getModelConfigService()
        .getAvailableModelOptions({
          useGemini3_1: useGemini31,
          useLatestFlash,
          useLatestFlashLite,
          useCustomTools: useCustomToolModel,
          hasAccessToPreview: shouldShowPreviewModels,
          hasAccessToProModel,
        });

      const list = allOptions
        .filter((o) => o.tier === 'auto')
        .map((o) => ({
          value: o.modelId,
          title: o.name,
          description: o.description,
          key: o.modelId,
        }));

      list.push({
        value: 'Manual',
        title: manualModelSelected
          ? `Manual (${getDisplayString(manualModelSelected, config ?? undefined)})`
          : 'Manual',
        description: 'Manually select a model',
        key: 'Manual',
      });
      return list;
    }

    const list = [
      {
        value: GEMINI_MODEL_ALIAS_AUTO,
        title: getDisplayString(GEMINI_MODEL_ALIAS_AUTO),
        description: getAutoModelDescription(
          shouldShowPreviewModels,
          useGemini31,
          useLatestFlash,
        ),
        key: GEMINI_MODEL_ALIAS_AUTO,
      },
      {
        value: 'Manual',
        title: manualModelSelected
          ? `Manual (${getDisplayString(manualModelSelected)})`
          : 'Manual',
        description: 'Manually select a model',
        key: 'Manual',
      },
    ];

    return list;
  }, [
    config,
    shouldShowPreviewModels,
    manualModelSelected,
    useGemini31,
    useLatestFlash,
    useLatestFlashLite,
    useCustomToolModel,
    hasAccessToProModel,
  ]);

  const manualOptions = useMemo(() => {
    if (selectedAuthType === AuthType.AFOT_AUTH) {
      return afotModels.map((model) => ({
        value: model,
        title: model,
        key: model,
      }));
    }

    if (
      config?.getExperimentalDynamicModelConfiguration?.() === true &&
      config.getModelConfigService
    ) {
      const allOptions = config
        .getModelConfigService()
        .getAvailableModelOptions({
          useGemini3_1: useGemini31,
          useLatestFlash,
          useLatestFlashLite,
          useCustomTools: useCustomToolModel,
          hasAccessToPreview: shouldShowPreviewModels,
          hasAccessToProModel,
        });

      return allOptions
        .filter((o) => o.tier !== 'auto')
        .map((o) => ({
          value: o.modelId,
          title: o.name,
          key: o.modelId,
        }));
    }

    const showGemmaModels = config?.getExperimentalGemma() ?? false;

    const options = [
      {
        value: DEFAULT_GEMINI_MODEL,
        title: getDisplayString(DEFAULT_GEMINI_MODEL),
        key: DEFAULT_GEMINI_MODEL,
      },
      {
        value: DEFAULT_GEMINI_FLASH_LITE_MODEL,
        title: getDisplayString(DEFAULT_GEMINI_FLASH_LITE_MODEL),
        key: DEFAULT_GEMINI_FLASH_LITE_MODEL,
      },
      {
        value: DEFAULT_GEMINI_FLASH_MODEL,
        title: getDisplayString(DEFAULT_GEMINI_FLASH_MODEL),
        key: DEFAULT_GEMINI_FLASH_MODEL,
      },
    ];

    if (showGemmaModels) {
      options.push(
        {
          value: GEMMA_4_31B_IT_MODEL,
          title: getDisplayString(GEMMA_4_31B_IT_MODEL),
          key: GEMMA_4_31B_IT_MODEL,
        },
        {
          value: GEMMA_4_26B_A4B_IT_MODEL,
          title: getDisplayString(GEMMA_4_26B_A4B_IT_MODEL),
          key: GEMMA_4_26B_A4B_IT_MODEL,
        },
      );
    }

    if (shouldShowPreviewModels) {
      const previewProModel = useGemini31
        ? PREVIEW_GEMINI_3_1_MODEL
        : PREVIEW_GEMINI_MODEL;

      const previewProValue = useCustomToolModel
        ? PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL
        : previewProModel;

      const previewOptions = [
        {
          value: previewProValue,
          title: getDisplayString(previewProModel),
          key: previewProModel,
        },
        {
          value: PREVIEW_GEMINI_FLASH_MODEL,
          title: getDisplayString(PREVIEW_GEMINI_FLASH_MODEL),
          key: PREVIEW_GEMINI_FLASH_MODEL,
        },
      ];

      if (PREVIEW_GEMINI_FLASH_LITE_MODEL !== 'none') {
        previewOptions.push({
          value: PREVIEW_GEMINI_FLASH_LITE_MODEL,
          title: getDisplayString(PREVIEW_GEMINI_FLASH_LITE_MODEL),
          key: PREVIEW_GEMINI_FLASH_LITE_MODEL,
        });
      }

      options.unshift(...previewOptions);
    }

    if (!hasAccessToProModel) {
      return options.filter((option) => !isProModel(option.value));
    }

    return options;
  }, [
    shouldShowPreviewModels,
    useGemini31,
    useLatestFlash,
    useLatestFlashLite,
    useCustomToolModel,
    hasAccessToProModel,
    config,
    selectedAuthType,
    afotModels,
  ]);

  const options = useMemo(() => {
    const rawOptions = view === 'main' ? mainOptions : manualOptions;
    const seen = new Set<string>();
    return rawOptions.filter((option) => {
      if (seen.has(option.value)) {
        return false;
      }
      seen.add(option.value);
      return true;
    });
  }, [view, mainOptions, manualOptions]);

  const initialIndex = useMemo(() => {
    const idx = options.findIndex((option) => option.value === preferredModel);
    if (idx !== -1) {
      return idx;
    }
    if (view === 'main') {
      const manualIdx = options.findIndex((o) => o.value === 'Manual');
      return manualIdx !== -1 ? manualIdx : 0;
    }
    return 0;
  }, [preferredModel, options, view]);

  const handleSelect = useCallback(
    (model: string) => {
      if (model === 'Manual') {
        setView('manual');
        return;
      }

      if (config) {
        config.setModel(model, persistMode ? false : true);
        const event = new ModelSlashCommandEvent(model);
        logModelSlashCommand(config, event);
      }
      onClose();
    },
    [config, onClose, persistMode],
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>Select Model</Text>

      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={options}
          onSelect={handleSelect}
          initialIndex={initialIndex}
          showNumbers={true}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text bold color={theme.text.primary}>
            Remember model for future sessions:{' '}
          </Text>
          <Text color={theme.status.success}>
            {persistMode ? 'true' : 'false'}
          </Text>
          <Text color={theme.text.secondary}> (Press Tab to toggle)</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {selectedAuthType === AuthType.AFOT_AUTH && afotProviderName
            ? `> Provider: ${afotProviderName}. Models discovered live from /models.`
            : '> To use a specific Gemini model on startup, use the --model flag.'}
        </Text>
      </Box>
      <ModelQuotaDisplay
        buckets={config?.getLastRetrievedQuota()?.buckets}
        availableWidth={terminalWidth - 2}
      />
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>(Press Esc to close)</Text>
      </Box>
    </Box>
  );
}

// ─── Main ModelDialog Export ──────────────────────────────────────────────────

export function ModelDialog({ onClose }: ModelDialogProps): React.JSX.Element {
  const settings = useSettings();
  const selectedAuthType = settings.merged.security.auth.selectedType;

  if (selectedAuthType === AuthType.AFOT_AUTH) {
    return <AfotUnifiedModelDialog onClose={onClose} />;
  }

  return <LegacyModelDialog onClose={onClose} />;
}
