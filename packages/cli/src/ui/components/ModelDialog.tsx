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
  readAfotAuthFile,
  setAfotDefaultProvider,
  setAfotProviderDefaultModel,
  getAfotRecentModels,
  saveAfotRecentModel,
  toggleAfotFavorite,
  OPENCODE_FREE_MODELS,
  BUILTIN_PROVIDERS,
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
    'nemotron-3.5-super-vl-120b-a12b': 'Nemotron 3.5 Super VL',
    'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning Free',
    'nemotron-3.5-lightning-30b-a3b': 'Nemotron 3.5 Lightning 30B',
    'nemotron-3.5-bolt-e4b': 'Nemotron 3.5 Bolt',
    'nemotron-3-nano-omni-30b-a3b-reasoning': 'Nemotron 3 Nano Omni 30B Reasoning',
    'nemotron-3-ultra-550b-a55b': 'Nemotron 3 Ultra 550B',
    'nemotron-3-super-120b-a12b': 'Nemotron 3 Super 120B',
    'nemotron-nano-3-30b-a3b': 'Nemotron Nano 3 30B',
    'nemotron-4-340b-instruct': 'Nemotron 4 340B Instruct',
    'llama-3.1-nemotron-70b-instruct': 'Llama 3.1 Nemotron 70B',
    'llama-3.1-nemotron-51b-instruct': 'Llama 3.1 Nemotron 51B',
    'llama-3.1-nemotron-ultra-253b-v1': 'Llama 3.1 Nemotron Ultra 253B',
    'llama3-chatqa-1.5-70b': 'Llama 3 ChatQA 70B',
    'mistral-nemo-minitron-8b-8k-instruct': 'Mistral NeMo Minitron 8B',
    'cosmos-reason2-8b': 'Cosmos Reason2 8B',
    'laguna-xs-2.1': 'Laguna Xs 2.1',
    'llama-3.2-90b-vision-instruct': 'Llama 3.2 90B Vision',
    'codellama-70b': 'CodeLlama 70B',
    'llama2-70b': 'Llama 2 70B',
    'mistral-large-2-instruct': 'Mistral Large 2',
    'mistral-large-4-1t-a52b': 'Mistral Large 4',
    'mistral-large': 'Mistral Large',
    'mixtral-8x22b-v0.1': 'Mixtral 8x22B',
    'codestral-22b-instruct-v0.1': 'Codestral 22B',
    'mistral-7b-instruct-v0.3': 'Mistral 7B Instruct',
    'mistral-nemo-12b-instruct': 'Mistral NeMo 12B',
    'gemma-3-12b-it': 'Gemma 3 12B IT',
    'gemma-3-4b-it': 'Gemma 3 4B IT',
    'gemma-4-31b-it': 'Gemma 4 31B IT',
    'gemma-2b': 'Gemma 2B',
    'recurrentgemma-2b': 'RecurrentGemma 2B',
    'codegemma-1.1-7b': 'CodeGemma 1.1 7B',
    'codegemma-7b': 'CodeGemma 7B',
    'diffusiongemma-26b-a4b-it': 'DiffusionGemma 26B IT',
    'deplot': 'DePlot',
    'phi-3-vision-128k-instruct': 'Phi 3 Vision 128K',
    'phi-3.5-moe-instruct': 'Phi-3.5 MoE',
    'kosmos-2': 'Kosmos 2',
    'fuyu-8b': 'Fuyu 8B',
    'neva-22b': 'NeVA 22B',
    'vila': 'VILA 1.5',
    'gpt-oss-20b': 'GPT-OSS 20B',
    'deepseek-coder-6.7b-instruct': 'DeepSeek Coder 6.7B',
    'yi-large': 'Yi Large',
    'palmyra-creative-122b': 'Palmyra Creative 122B',
    'palmyra-fin-70b-32k': 'Palmyra Fin 70B',
    'palmyra-med-70b': 'Palmyra Med 70B',
    'palmyra-med-70b-32k': 'Palmyra Med 70B 32K',
    'step-5-preview': 'Step-5 Preview',
    'muse-glimmer-30b': 'Muse Glimmer 30B',
    'granite-3.0-8b-instruct': 'Granite 3.0 8B',
    'granite-3.0-3b-a800m-instruct': 'Granite 3.0 3B',
    'granite-34b-code-instruct': 'Granite 34B Code',
    'granite-8b-code-instruct': 'Granite 8B Code',
    'starcoder2-15b': 'StarCoder2 15B',
    'dbrx-instruct': 'DBRX Instruct',
    'sea-lion-7b-instruct': 'SEA-LION 7B',
    'zamba2-7b-instruct': 'Zamba2 7B',
    'jamba-1.5-large-instruct': 'Jamba 1.5 Large',
    'riva-translate-4b-instruct': 'Riva Translate 4B',
    'riva-translate-4b-instruct-v2': 'Riva Translate 4B V2',
    'crouton-alpha-free': 'Crouton Alpha Free',
    'flint-40b-free': 'Flint 40B Free',
    'iceman-free': 'Iceman Free',
    'inkling-2-small-free': 'Inkling 2 Small Free',
    'beam-free': 'Beam Free',
    'big-pickle': 'Big Pickle',
    'mimo-v2.6-flash-free': 'Mimo V2.6 Flash Free',
    'kimi-k2.6': 'Kimi K2.6',
    'kimi-k2-instruct': 'Kimi K2 Instruct',
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
    return known[base.toLowerCase()]!;
  }

  return base
    .split(/[-_]/)
    .map((word) => {
      if (!word) return '';
      if (/^(ai|gpt|glm|vl|v\d+(\.\d+)?|\d+b|\d+k|b|mb|gb|it|oss|moe)$/i.test(word)) {
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
  if (providerKey === 'opencode') return true;
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

function getModelSearchScore(query: string, item: UnifiedModelItem): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;

  const id = item.id.toLowerCase();
  const name = item.name.toLowerCase();
  const base = (id.includes('/') ? id.split('/')[1]! : id).toLowerCase();
  const display = item.displayName.toLowerCase();
  const provKey = item.providerKey.toLowerCase();
  const provName = item.providerName.toLowerCase();

  // 1. Exact match on base, id, or formatted name
  if (base === q || id === q || name === q) return 1000;

  // 2. Starts with query (e.g. glm-5.3 starts with glm)
  if (base.startsWith(q) || id.startsWith(q) || name.startsWith(q)) return 800;

  // 3. Substring match (e.g. z-ai/glm-5.3-flash or GLM-5.3-Flash contains glm)
  if (id.includes(q) || name.includes(q) || base.includes(q) || display.includes(q)) return 500;

  // 4. Provider exact match or prefix
  if (provKey === q || provName === q) return 300;
  if (provKey.startsWith(q) || provName.startsWith(q)) return 200;
  if (provKey.includes(q) || provName.includes(q)) return 100;

  // 5. Loose fuzzy match on base or id or display
  if (fuzzyMatch(q, base) || fuzzyMatch(q, name) || fuzzyMatch(q, id)) return 10;
  if (fuzzyMatch(q, display)) return 5;

  return 0;
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
    const authFile = readAfotAuthFile() ?? {};
    const authenticatedProviders = Object.keys(authFile).filter((k) => {
      const v = authFile[k];
      if (!v) return false;
      if (v.type === 'api' && (v as { key?: string }).key?.trim()) return true;
      if (v.type === 'oauth' && (v as { access_token?: string }).access_token?.trim()) return true;
      return false;
    });

    for (const pKey of authenticatedProviders) {
      if (pKey === 'opencode') continue;
      void (async () => {
        try {
          const prov = resolveAfotProviderByName(pKey);
          if (prov) {
            const models = await fetchAfotProviderModels(prov);
            if (!cancelled && models.length > 0) {
              setLiveProviderModels((prev) => ({
                ...prev,
                [pKey]: models,
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
  }, [activeProvider, catalogVersion]);

  const allItems = useMemo(() => {
    const afotConf = readAfotConfig();
    const authFile = readAfotAuthFile() ?? {};
    const authenticatedProviders = new Set<string>();
    for (const [k, v] of Object.entries(authFile)) {
      if (!v) continue;
      if (v.type === 'api' && (v as { key?: string }).key?.trim()) {
        authenticatedProviders.add(k);
      } else if (v.type === 'oauth' && (v as { access_token?: string }).access_token?.trim()) {
        authenticatedProviders.add(k);
      }
    }

    const recents = getAfotRecentModels();
    const items: UnifiedModelItem[] = [];
    const recentKeySet = new Set<string>();

    // 1. Build Recent section (filtered to connected providers if any exist)
    for (const r of recents) {
      if (authenticatedProviders.size > 0 && !authenticatedProviders.has(r.provider)) {
        continue;
      }
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

    // Helper to add OpenCode models
    const addOpencodeModels = () => {
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
    };

    // Helper to add another provider's models
    const addProviderModels = (pKey: string) => {
      const pConfig = afotConf?.providers?.[pKey] ?? BUILTIN_PROVIDERS[pKey];
      if (!pConfig && !liveProviderModels[pKey]?.length) return;
      const builtinModels = BUILTIN_PROVIDERS[pKey]?.models ?? [];
      const configuredModels = pConfig?.models ?? [];
      const staticModels = Array.from(new Set([...configuredModels, ...builtinModels]));
      const live = liveProviderModels[pKey] ?? [];
      const staticSet = new Set(staticModels);
      const extraLive = live.filter((m) => !staticSet.has(m));
      const providerModels = [...staticModels, ...extraLive];
      if (providerModels.length === 0) return;
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
    };

    // 2. Prioritize active provider first (right under Recent)
    if (activeProvider === 'opencode') {
      if (authenticatedProviders.size === 0 || authenticatedProviders.has('opencode')) {
        addOpencodeModels();
      }
    } else if (activeProvider && authenticatedProviders.has(activeProvider)) {
      addProviderModels(activeProvider);
    }

    // 3. Add other connected/authenticated providers
    if (authenticatedProviders.size > 0) {
      for (const pKey of authenticatedProviders) {
        if (pKey === activeProvider) continue;
        if (pKey === 'opencode') {
          addOpencodeModels();
        } else {
          addProviderModels(pKey);
        }
      }
    } else {
      // If no provider authenticated yet, provide OpenCode as starter list
      if (activeProvider !== 'opencode') {
        addOpencodeModels();
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
    const scored = allItems
      .map((item) => ({ item, score: getModelSearchScore(searchQuery, item) }))
      .filter((entry) => entry.score > 0);

    const hasStrongMatches = scored.some((s) => s.score >= 500);
    const relevant = hasStrongMatches
      ? scored.filter((s) => s.score >= 100)
      : scored;

    relevant.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return 0;
    });

    return relevant.map((entry) => entry.item);
  }, [allItems, searchQuery]);

  const initialIndex = useMemo(() => {
    const idx = filteredItems.findIndex((it) => it.isActiveModel);
    return idx >= 0 ? idx : 0;
  }, [filteredItems]);

  const handleSelectModel = useCallback(
    async (item: UnifiedModelItem) => {
      setAfotDefaultProvider(item.providerKey);
      setAfotProviderDefaultModel(item.providerKey, item.id);
      if (config) {
        config.setModel(item.id, true);
        const event = new ModelSlashCommandEvent(item.id);
        logModelSlashCommand(config, event);
      }
      if (config?.refreshAuth) {
        await config.refreshAuth(AuthType.AFOT_AUTH);
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
            {'  '}{entry.section}
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
      flexDirection="column"
      paddingY={1}
      width={64}
    >
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1} width="100%">
        <Text bold color="#22c55e">
          {'  '}Select model
        </Text>
        <Text color={theme.text.secondary}>esc</Text>
      </Box>

      {/* Search Input */}
      <Box marginBottom={1} paddingLeft={2}>
        <TextInput
          buffer={searchBuffer}
          placeholder="Search"
          focus={!showConnect}
          onCancel={onClose}
        />
      </Box>

      {/* Scroll indicator up */}
      {scrollOffset > 0 && (
        <Box paddingLeft={2}>
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
        <Box paddingLeft={2}>
          <Text color={theme.text.secondary}>▼</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} flexDirection="row">
        <Text color="#4ade80">{'  '}Connect an integration </Text>
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
