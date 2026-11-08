/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GoogleGenAI,
  type CountTokensResponse,
  type GenerateContentResponse,
  type GenerateContentParameters,
  type CountTokensParameters,
  type EmbedContentResponse,
  type EmbedContentParameters,
} from '@google/genai';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as os from 'node:os';
import { createCodeAssistContentGenerator } from '../code_assist/codeAssist.js';
import { isCloudShell } from '../ide/detect-ide.js';
import type { Config } from '../config/config.js';
import { resolveAfotProvider } from './afotAuthStorage.js';

import type { UserTierId, GeminiUserTier } from '../code_assist/types.js';
import { LoggingContentGenerator } from './loggingContentGenerator.js';
import { FakeContentGenerator } from './fakeContentGenerator.js';
import { parseCustomHeaders } from '../utils/customHeaderUtils.js';
import { determineSurface } from '../utils/surface.js';
import { RecordingContentGenerator } from './recordingContentGenerator.js';
import { getVersion, resolveModel } from '../../index.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import { ModelMappingContentGenerator } from './modelMappingContentGenerator.js';
import { getBackendModelMappings } from '../config/models.js';

/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;

  userTier?: UserTierId;

  userTierName?: string;

  paidTier?: GeminiUserTier;
}

export enum AuthType {
  // ── Removed Google-specific auth types ───────────────────────────────────
  // LOGIN_WITH_GOOGLE, USE_GEMINI, USE_VERTEX_AI have been removed.
  // Use AFOT_AUTH instead for provider-based API key authentication.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Legacy Cloud Shell marker — immediately migrated to COMPUTE_ADC on load.
   * Kept for backward-compat with old settings.json values only.
   */
  LEGACY_CLOUD_SHELL = 'cloud-shell',

  /**
   * Application Default Credentials (Cloud Shell / GCE metadata server).
   * Used when CLOUD_SHELL=true or GEMINI_CLI_USE_COMPUTE_ADC=true.
   */
  COMPUTE_ADC = 'compute-default-credentials',

  /**
   * Custom AI API Gateway — pass a baseUrl and optional api key.
   * Used in ACP/headless mode via GOOGLE_GEMINI_BASE_URL env var.
   */
  GATEWAY = 'gateway',

  /**
   * AFOT multi-provider auth.
   * Reads credentials from ~/.afot/auth.json and provider config from
   * ~/.afot/config.json. Fully isolated from OpenCode and Google auth.
   *
   * Set AFOT_PROVIDER env var to pick a specific provider, or let
   * the system use config.json "defaultProvider" / first api entry.
   */
  AFOT_AUTH = 'afot-auth',
}

/**
 * Detects the best authentication type based on environment variables.
 *
 * Checks in order:
 * 1. AFOT_AUTH env vars (AFOT_PROVIDER set, or ~/.afot/auth.json exists) -> AFOT_AUTH
 * 2. GOOGLE_GEMINI_BASE_URL -> GATEWAY
 * 3. CLOUD_SHELL=true or GEMINI_CLI_USE_COMPUTE_ADC=true -> COMPUTE_ADC
 */
export function getAuthTypeFromEnv(): AuthType | undefined {
  // AFOT_PROVIDER explicitly set, or AFOT_AUTH env flag
  if (
    process.env['AFOT_PROVIDER'] ||
    process.env['AFOT_AUTH'] === 'true'
  ) {
    return AuthType.AFOT_AUTH;
  }
  if (process.env['GOOGLE_GEMINI_BASE_URL']) {
    return AuthType.GATEWAY;
  }
  if (
    process.env['CLOUD_SHELL'] === 'true' ||
    process.env['GEMINI_CLI_USE_COMPUTE_ADC'] === 'true'
  ) {
    return AuthType.COMPUTE_ADC;
  }
  return undefined;
}

export type ContentGeneratorConfig = {
  apiKey?: string;
  vertexai?: boolean;
  authType?: AuthType;
  proxy?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
  vertexAiRouting?: VertexAiRoutingConfig;
};

export type VertexAiRequestType = 'dedicated' | 'shared';
export type VertexAiSharedRequestType = 'priority' | 'flex';

export interface VertexAiRoutingConfig {
  requestType?: VertexAiRequestType;
  sharedRequestType?: VertexAiSharedRequestType;
}



function validateBaseUrl(baseUrl: string): void {
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`Invalid custom base URL: ${baseUrl}`);
  }
}

export async function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
  apiKey?: string,
  baseUrl?: string,
  customHeaders?: Record<string, string>,
  vertexAiRouting?: VertexAiRoutingConfig,
): Promise<ContentGeneratorConfig> {
  const contentGeneratorConfig: ContentGeneratorConfig = {
    authType,
    proxy: config?.getProxy(),
    baseUrl,
    customHeaders,
    vertexAiRouting,
  };

  const getEnv = (key: string) => {
    if (config?.env && config.env[key] !== undefined) {
      return config.env[key];
    }
    return process.env[key];
  };

  // COMPUTE_ADC: no API key needed — return early to avoid keychain access
  // on headless environments where keytar can block indefinitely.
  if (authType === AuthType.COMPUTE_ADC) {
    return contentGeneratorConfig;
  }

  // GATEWAY: use provided key or env var (empty string is valid for gateway-
  // side auth where the gateway itself holds credentials).
  if (authType === AuthType.GATEWAY) {
    contentGeneratorConfig.apiKey = apiKey || getEnv('GEMINI_API_KEY') || '';
    contentGeneratorConfig.vertexai = false;
    return contentGeneratorConfig;
  }

  // AFOT_AUTH: resolve provider from ~/.afot/auth.json + ~/.afot/config.json
  if (authType === AuthType.AFOT_AUTH) {
    const provider = resolveAfotProvider();
    if (provider) {
      contentGeneratorConfig.apiKey = provider.key;
      contentGeneratorConfig.baseUrl = baseUrl || provider.baseUrl;
      contentGeneratorConfig.vertexai = false;
      // Merge any per-provider headers from config.json
      if (provider.headers) {
        contentGeneratorConfig.customHeaders = {
          ...provider.headers,
          ...(customHeaders ?? {}),
        };
      }
    }
    return contentGeneratorConfig;
  }

  return contentGeneratorConfig;
}

export async function createContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
  sessionId?: string,
): Promise<ContentGenerator> {
  const generator = await (async () => {
    if (gcConfig.fakeResponsesNonStrict) {
      const fakeGenerator = await FakeContentGenerator.fromFile(
        gcConfig.fakeResponsesNonStrict,
        { nonStrict: true },
      );
      return new LoggingContentGenerator(fakeGenerator, gcConfig);
    }
    if (gcConfig.fakeResponses) {
      const fakeGenerator = await FakeContentGenerator.fromFile(
        gcConfig.fakeResponses,
      );
      return new LoggingContentGenerator(fakeGenerator, gcConfig);
    }
    const version = await getVersion();
    const model = resolveModel(
      gcConfig.getModel(),
      config.authType === AuthType.AFOT_AUTH ||
        config.authType === AuthType.GATEWAY ||
        ((await gcConfig.getGemini31Launched?.()) ?? false),
      false,
      gcConfig.getHasAccessToPreviewModel?.() ?? true,
      gcConfig,
      gcConfig.hasGemini35FlashGAAccess?.() ?? false,
    );
    const customHeadersEnv =
      process.env['GEMINI_CLI_CUSTOM_HEADERS'] || undefined;
    const clientName = gcConfig.getClientName();
    const surface = determineSurface();

    let userAgent: string;
    // Use unified format for VS Code traffic.
    // Note: We don't automatically assume a2a-server is VS Code,
    // as it could be used by other clients unless the surface explicitly says 'vscode'.
    if (clientName === 'acp-vscode' || surface === 'vscode') {
      const osTypeMap: Record<string, string> = {
        darwin: 'macOS',
        win32: 'Windows',
        linux: 'Linux',
      };
      const osType = osTypeMap[process.platform] || process.platform;
      const osVersion = os.release();
      const arch = process.arch;

      const vscodeVersion = process.env['TERM_PROGRAM_VERSION'] || 'unknown';
      let hostPath = `VSCode/${vscodeVersion}`;
      if (isCloudShell()) {
        const cloudShellVersion =
          process.env['CLOUD_SHELL_VERSION'] || 'unknown';
        hostPath += ` > CloudShell/${cloudShellVersion}`;
      }

      userAgent = `CloudCodeVSCode/${version} (aidev_client; os_type=${osType}; os_version=${osVersion}; arch=${arch}; host_path=${hostPath}; proxy_client=geminicli)`;
    } else {
      const userAgentPrefix = clientName
        ? `GeminiCLI-${clientName}`
        : 'GeminiCLI';
      userAgent = `${userAgentPrefix}/${version}/${model} (${process.platform}; ${process.arch}; ${surface})`;
    }

    const customHeadersMap = parseCustomHeaders(customHeadersEnv);
    const apiVersionEnv = process.env['GOOGLE_GENAI_API_VERSION'];

    const baseHeaders: Record<string, string> = {
      'User-Agent': userAgent,
      ...customHeadersMap,
    };

    if (
      config.authType === AuthType.COMPUTE_ADC
    ) {
      const httpOptions = { headers: baseHeaders };
      return new LoggingContentGenerator(
        new ModelMappingContentGenerator(
          await createCodeAssistContentGenerator(
            httpOptions,
            config.authType,
            gcConfig,
            sessionId,
          ),
          () => getBackendModelMappings(gcConfig, true),
        ),
        gcConfig,
      );
    }

    if (
      config.authType === AuthType.GATEWAY ||
      config.authType === AuthType.AFOT_AUTH
    ) {
      // AFOT_AUTH: use OpenAI-compatible adapter for third-party providers
      if (config.authType === AuthType.AFOT_AUTH && config.apiKey && config.baseUrl) {
        const { AfotOpenAIContentGenerator } = await import(
          './afotOpenAIContentGenerator.js'
        );
        const {
          resolveAfotProvider,
          resolveAfotActiveProviderName,
          fetchAfotProviderModels,
        } = await import('./afotAuthStorage.js');
        const { resolveOpenCodeProvider } = await import('./opencodeConsoleAuth.js');

        const activeProviderName = resolveAfotActiveProviderName();
        const openCodeProvider =
          activeProviderName === 'opencode'
            ? await resolveOpenCodeProvider().catch(() => null)
            : null;
        const provider =
          openCodeProvider ?? resolveAfotProvider();

        if (provider) {
          const liveModels = openCodeProvider
            ? openCodeProvider.models
            : await fetchAfotProviderModels(provider);
          const selectedModel = gcConfig.getModel();
          const configuredDefault =
            (provider as import('./afotAuthStorage.js').AfotResolvedProvider).defaultModel;
          const matchedSelected = selectedModel
            ? liveModels.find(
                (m) =>
                  m === selectedModel ||
                  m.toLowerCase() === selectedModel.toLowerCase() ||
                  m.toLowerCase().endsWith(`/${selectedModel.toLowerCase()}`) ||
                  selectedModel.toLowerCase().endsWith(`/${m.toLowerCase()}`),
              )
            : undefined;
          const matchedDefault = configuredDefault
            ? liveModels.find(
                (m) =>
                  m === configuredDefault ||
                  m.toLowerCase() === configuredDefault.toLowerCase() ||
                  m.toLowerCase().endsWith(`/${configuredDefault.toLowerCase()}`) ||
                  configuredDefault.toLowerCase().endsWith(`/${m.toLowerCase()}`),
              )
            : undefined;
          const effectiveModel =
            matchedSelected ?? matchedDefault ?? liveModels[0];

          if (!effectiveModel) {
            throw new Error(
              `No live models returned for provider "${provider.name}". Check credentials and provider availability.`,
            );
          }

          const openAIGenerator = new AfotOpenAIContentGenerator(
            {
              name: provider.name,
              key: provider.key,
              baseUrl: provider.baseUrl,
              models: liveModels,
              defaultModel: openCodeProvider
                ? effectiveModel
                : (provider as import('./afotAuthStorage.js').AfotResolvedProvider).defaultModel,
            },
            effectiveModel,
          );
          return new LoggingContentGenerator(
            new ModelMappingContentGenerator(openAIGenerator, () =>
              getBackendModelMappings(gcConfig, false),
            ),
            gcConfig,
          );
        }
      }

      // GATEWAY: use GoogleGenAI with custom baseUrl (Gemini-compatible endpoints)
      let headers: Record<string, string> = { ...baseHeaders };
      if (config.customHeaders) {
        headers = { ...headers, ...config.customHeaders };
      }

      // AFOT: installation ID header removed — no tracking identifiers sent to API

      // For GATEWAY with empty api key, explicitly clear the api key header
      if (config.authType === AuthType.GATEWAY && config.apiKey === '') {
        headers['x-goog-api-key'] = '';
      }

      let baseUrl = config.baseUrl;
      if (!baseUrl && config.authType === AuthType.GATEWAY) {
        const envBaseUrl = process.env['GOOGLE_GEMINI_BASE_URL'];
        if (envBaseUrl) {
          validateBaseUrl(envBaseUrl);
          baseUrl = envBaseUrl;
        }
      } else if (baseUrl) {
        validateBaseUrl(baseUrl);
      }

      const httpOptions: {
        baseUrl?: string;
        headers: Record<string, string>;
      } = { headers };

      if (baseUrl) {
        httpOptions.baseUrl = baseUrl;
      }

      const proxyUrl = config.proxy?.trim();
      const proxyAgent = proxyUrl
        ? baseUrl?.startsWith('http://')
          ? new HttpProxyAgent(proxyUrl)
          : new HttpsProxyAgent(proxyUrl)
        : undefined;

      const googleGenAI = new GoogleGenAI({
        apiKey:
          config.authType === AuthType.GATEWAY
            ? config.apiKey
            : config.apiKey === ''
              ? undefined
              : config.apiKey,
        vertexai: false,
        httpOptions,
        ...(apiVersionEnv && { apiVersion: apiVersionEnv }),
        ...(proxyAgent && {
          googleAuthOptions: {
            clientOptions: {
              transporterOptions: { agent: proxyAgent },
            },
          },
        }),
      });
      return new LoggingContentGenerator(
        new ModelMappingContentGenerator(googleGenAI.models, () =>
          getBackendModelMappings(gcConfig, false),
        ),
        gcConfig,
      );
    }
    throw new Error(
      `Error creating contentGenerator: Unsupported authType: ${config.authType}`,
    );
  })();

  if (gcConfig.recordResponses) {
    return new RecordingContentGenerator(generator, gcConfig.recordResponses);
  }

  return generator;
}
