/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createContentGenerator,
  AuthType,
  createContentGeneratorConfig,
  getAuthTypeFromEnv,
  type ContentGenerator,
} from './contentGenerator.js';
import { createCodeAssistContentGenerator } from '../code_assist/codeAssist.js';
import { GoogleGenAI } from '@google/genai';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Config } from '../config/config.js';
import { LoggingContentGenerator } from './loggingContentGenerator.js';
import { ModelMappingContentGenerator } from './modelMappingContentGenerator.js';
import { resolveAfotProvider } from './afotAuthStorage.js';
import { FakeContentGenerator } from './fakeContentGenerator.js';
import { RecordingContentGenerator } from './recordingContentGenerator.js';
import { resetVersionCache } from '../utils/version.js';
import type { LlmRole } from '../telemetry/llmRole.js';

vi.mock('../code_assist/codeAssist.js');
vi.mock('@google/genai');
vi.mock('./apiKeyCredentialStorage.js', () => ({
  loadApiKey: vi.fn(),
}));
vi.mock('./afotAuthStorage.js', () => ({
  resolveAfotProvider: vi.fn(),
  resolveAfotActiveProviderName: vi.fn(),
  fetchAfotProviderModels: vi.fn().mockResolvedValue([]),
  readAfotAuthFile: vi.fn(),
  readAfotConfig: vi.fn(),
  listAfotProviders: vi.fn(),
  validateAfotAuth: vi.fn(),
  ensureAfotDir: vi.fn(),
  getAfotDir: vi.fn().mockReturnValue('/tmp/test-afot'),
  getAfotAuthFilePath: vi.fn(),
  getAfotConfigFilePath: vi.fn(),
  setAfotProviderKey: vi.fn(),
  setAfotDefaultProvider: vi.fn(),
  getAllAfotProviderStatus: vi.fn(),
  setAfotProviderDefaultModel: vi.fn(),
  getAfotRecentModels: vi.fn().mockReturnValue([]),
  saveAfotRecentModel: vi.fn(),
  getAfotFavorites: vi.fn().mockReturnValue([]),
  toggleAfotFavorite: vi.fn().mockReturnValue(true),
  BUILTIN_PROVIDERS: {},
  LOCAL_PROVIDERS: new Set(),
  generateBlankAuthFile: vi.fn(),
  generateDefaultConfigFile: vi.fn(),
}));

vi.mock('./fakeContentGenerator.js');

const mockConfig = {
  getModel: vi.fn().mockReturnValue('gemini-pro'),
  getProxy: vi.fn().mockReturnValue(undefined),
  getUsageStatisticsEnabled: vi.fn().mockReturnValue(true),
  getClientName: vi.fn().mockReturnValue(undefined),
  getTelemetryLogPromptsEnabled: vi.fn().mockReturnValue(true),
  getTelemetryTracesEnabled: vi.fn().mockReturnValue(true),
  getSessionId: vi.fn().mockReturnValue('test-session-id'),
  refreshUserQuotaIfStale: vi.fn().mockResolvedValue(undefined),
  setLatestApiRequest: vi.fn(),
  getContentGeneratorConfig: vi.fn().mockReturnValue({}),
  isInteractive: vi.fn().mockReturnValue(false),
  getExperiments: vi.fn().mockReturnValue(undefined),
} as unknown as Config;

describe('getAuthTypeFromEnv', () => {
  beforeEach(() => {
    vi.stubEnv('AFOT_PROVIDER', '');
    vi.stubEnv('AFOT_AUTH', '');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '');
    vi.stubEnv('CLOUD_SHELL', '');
    vi.stubEnv('GEMINI_CLI_USE_COMPUTE_ADC', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_GENAI_USE_GCA', '');
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should detect AFOT_AUTH when AFOT_PROVIDER is set', () => {
    vi.stubEnv('AFOT_PROVIDER', 'openrouter');
    expect(getAuthTypeFromEnv()).toBe(AuthType.AFOT_AUTH);
  });

  it('should detect AFOT_AUTH when AFOT_AUTH=true', () => {
    vi.stubEnv('AFOT_AUTH', 'true');
    expect(getAuthTypeFromEnv()).toBe(AuthType.AFOT_AUTH);
  });

  it('should detect GATEWAY when GOOGLE_GEMINI_BASE_URL is present', () => {
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://gateway.example.com');
    expect(getAuthTypeFromEnv()).toBe(AuthType.GATEWAY);
  });

  it('should detect COMPUTE_ADC when CLOUD_SHELL is true', () => {
    vi.stubEnv('CLOUD_SHELL', 'true');
    expect(getAuthTypeFromEnv()).toBe(AuthType.COMPUTE_ADC);
  });

  it('should detect COMPUTE_ADC when GEMINI_CLI_USE_COMPUTE_ADC is true', () => {
    vi.stubEnv('GEMINI_CLI_USE_COMPUTE_ADC', 'true');
    expect(getAuthTypeFromEnv()).toBe(AuthType.COMPUTE_ADC);
  });

  it('should return undefined when no matching env variables are set', () => {
    expect(getAuthTypeFromEnv()).toBeUndefined();
  });
});

describe('createContentGenerator', () => {
  beforeEach(() => {
    resetVersionCache();
    vi.clearAllMocks();
    vi.stubEnv('ANTIGRAVITY_CLI_ALIAS', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should create a FakeContentGenerator', async () => {
    const mockGenerator = {} as unknown as ContentGenerator;
    vi.mocked(FakeContentGenerator.fromFile).mockResolvedValue(
      mockGenerator as never,
    );
    const fakeResponsesFile = 'fake/responses.yaml';
    const mockConfigWithFake = {
      fakeResponses: fakeResponsesFile,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        authType: AuthType.AFOT_AUTH,
      },
      mockConfigWithFake,
    );
    expect(FakeContentGenerator.fromFile).toHaveBeenCalledWith(
      fakeResponsesFile,
    );
    expect(generator).toEqual(
      new LoggingContentGenerator(mockGenerator, mockConfigWithFake),
    );
  });

  it('should create a RecordingContentGenerator', async () => {
    const fakeResponsesFile = 'fake/responses.yaml';
    const recordResponsesFile = 'record/responses.yaml';
    const mockConfigWithRecordResponses = {
      fakeResponses: fakeResponsesFile,
      recordResponses: recordResponsesFile,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        authType: AuthType.AFOT_AUTH,
      },
      mockConfigWithRecordResponses,
    );
    expect(generator).toBeInstanceOf(RecordingContentGenerator);
  });

  it('should create a CodeAssistContentGenerator when AuthType is COMPUTE_ADC', async () => {
    const mockGenerator = {} as unknown as ContentGenerator;
    vi.mocked(createCodeAssistContentGenerator).mockResolvedValue(
      mockGenerator as never,
    );
    const generator = await createContentGenerator(
      {
        authType: AuthType.COMPUTE_ADC,
      },
      mockConfig,
    );
    expect(createCodeAssistContentGenerator).toHaveBeenCalled();
    expect(generator).toEqual(
      new LoggingContentGenerator(
        new ModelMappingContentGenerator(mockGenerator, expect.any(Function)),
        mockConfig,
      ),
    );
  });

  it('should create a GoogleGenAI content generator', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => true,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    // Set a fixed version for testing
    vi.stubEnv('CLI_VERSION', '1.2.3');
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app');
    vi.stubEnv('VSCODE_PID', '');
    vi.stubEnv('GITHUB_SHA', '');
    vi.stubEnv('GEMINI_CLI_SURFACE', '');

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    const generator = await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );
    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: false,
      httpOptions: expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.stringMatching(
            /GeminiCLI\/1\.2\.3\/gemini-pro \(.*; .*; terminal\)/,
          ),
        }),
      }),
    });
    expect(generator).toEqual(
      new LoggingContentGenerator(
        new ModelMappingContentGenerator(
          mockGenerator.models,
          expect.any(Function),
        ),
        mockConfig,
      ),
    );
  });

  it('should use standard User-Agent for a2a-server running outside VS Code', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => true,
      getClientName: vi.fn().mockReturnValue('a2a-server'),
    } as unknown as Config;

    // Set a fixed version for testing
    vi.stubEnv('CLI_VERSION', '1.2.3');
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app');
    vi.stubEnv('VSCODE_PID', '');
    vi.stubEnv('GITHUB_SHA', '');
    vi.stubEnv('GEMINI_CLI_SURFACE', '');

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    await createContentGenerator(
      { apiKey: 'test-api-key', authType: AuthType.AFOT_AUTH },
      mockConfig,
      undefined,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringMatching(
              /GeminiCLI-a2a-server\/1\.2\.3\/gemini-pro \(.*; .*; terminal\)/,
            ),
          }),
        }),
      }),
    );
  });

  it('should include unified User-Agent for a2a-server (VS Code Agent Mode)', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => true,
      getClientName: vi.fn().mockReturnValue('a2a-server'),
    } as unknown as Config;

    // Set a fixed version for testing
    vi.stubEnv('CLI_VERSION', '1.2.3');
    // Mock the environment variable that the VS Code extension host would provide to the a2a-server process
    vi.stubEnv('VSCODE_PID', '12345');
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('TERM_PROGRAM_VERSION', '1.85.0');

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    await createContentGenerator(
      { apiKey: 'test-api-key', authType: AuthType.AFOT_AUTH },
      mockConfig,
      undefined,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringMatching(
              /CloudCodeVSCode\/1\.2\.3 \(aidev_client; os_type=.*; os_version=.*; arch=.*; host_path=VSCode\/1\.85\.0; proxy_client=geminicli\)/,
            ),
          }),
        }),
      }),
    );
  });

  it('should include clientName prefix in User-Agent when specified (non-VSCode)', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => true,
      getClientName: vi.fn().mockReturnValue('my-client'),
    } as unknown as Config;

    // Set a fixed version for testing
    vi.stubEnv('CLI_VERSION', '1.2.3');
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app');
    vi.stubEnv('VSCODE_PID', '');
    vi.stubEnv('GITHUB_SHA', '');
    vi.stubEnv('GEMINI_CLI_SURFACE', '');

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    await createContentGenerator(
      { apiKey: 'test-api-key', authType: AuthType.AFOT_AUTH },
      mockConfig,
      undefined,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringMatching(
              /GeminiCLI-my-client\/1\.2\.3\/gemini-pro \(.*; .*; terminal\)/,
            ),
          }),
        }),
      }),
    );
  });

  it('should allow custom headers to override User-Agent', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => true,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    vi.stubEnv('GEMINI_CLI_CUSTOM_HEADERS', 'User-Agent:MyCustomUA');

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    await createContentGenerator(
      { apiKey: 'test-api-key', authType: AuthType.AFOT_AUTH },
      mockConfig,
      undefined,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': 'MyCustomUA',
          }),
        }),
      }),
    );
  });

  it.skip('should include custom headers from GEMINI_CLI_CUSTOM_HEADERS for Code Assist requests', async () => {
    const mockGenerator = {} as unknown as ContentGenerator;
    vi.mocked(createCodeAssistContentGenerator).mockResolvedValue(
      mockGenerator as never,
    );
    vi.stubEnv(
      'GEMINI_CLI_CUSTOM_HEADERS',
      'X-Test-Header: test-value, Another-Header: another value',
    );

    await createContentGenerator(
      {
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );

    expect(createCodeAssistContentGenerator).toHaveBeenCalledWith(
      {
        headers: expect.objectContaining({
          'User-Agent': expect.any(String),
          'X-Test-Header': 'test-value',
          'Another-Header': 'another value',
        }),
      },
      AuthType.AFOT_AUTH,
      mockConfig,
      undefined,
    );
  });

  it('should include custom headers from GEMINI_CLI_CUSTOM_HEADERS for GoogleGenAI requests without inferring auth mechanism', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.stubEnv(
      'GEMINI_CLI_CUSTOM_HEADERS',
      'X-Test-Header: test, Another: value',
    );

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: false,
      httpOptions: expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.any(String),
          'X-Test-Header': 'test',
          Another: 'value',
        }),
      }),
    });
    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.not.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.any(String),
          }),
        }),
      }),
    );
  });

  it.skip('should include Vertex AI routing headers for Vertex AI requests', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        vertexai: true,
        authType: AuthType.GATEWAY,
        vertexAiRouting: {
          requestType: 'shared',
          sharedRequestType: 'priority',
        },
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            'X-Vertex-AI-LLM-Request-Type': 'shared',
            'X-Vertex-AI-LLM-Shared-Request-Type': 'priority',
          }),
        }),
      }),
    );
  });

  it.skip('should use US REP endpoint for Vertex AI when location is us and no baseUrl is provided', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);

    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us');

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        vertexai: true,
        authType: AuthType.GATEWAY,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        googleAuthOptions: expect.objectContaining({
          clientOptions: expect.objectContaining({
            apiEndpoint: 'https://aiplatform.us.rep.googleapis.com',
          }),
        }),
        httpOptions: expect.objectContaining({
          baseUrl: 'https://aiplatform.us.rep.googleapis.com',
        }),
      }),
    );
  });

  it.skip('should use EU REP endpoint for Vertex AI when location is eu and no baseUrl is provided', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);

    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'eu');

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        vertexai: true,
        authType: AuthType.GATEWAY,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        googleAuthOptions: expect.objectContaining({
          clientOptions: expect.objectContaining({
            apiEndpoint: 'https://aiplatform.eu.rep.googleapis.com',
          }),
        }),
        httpOptions: expect.objectContaining({
          baseUrl: 'https://aiplatform.eu.rep.googleapis.com',
        }),
      }),
    );
  });

  it('should inject HttpsProxyAgent into googleAuthOptions when proxy URL uses https://', async () => {
    const mockConfigWithProxy = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue('https://proxy.example.com:8080'),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator);

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        vertexai: true,
        authType: AuthType.GATEWAY,
        proxy: 'https://proxy.example.com:8080',
      },
      mockConfigWithProxy,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        googleAuthOptions: expect.objectContaining({
          clientOptions: expect.objectContaining({
            transporterOptions: expect.objectContaining({
              agent: expect.any(HttpsProxyAgent),
            }),
          }),
        }),
      }),
    );
  });

  it('should still use HttpsProxyAgent for HTTPS destinations even when proxy URL uses http://', async () => {
    const mockConfigWithProxy = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue('http://proxy.example.com:8080'),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator);

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        vertexai: true,
        authType: AuthType.GATEWAY,
        proxy: 'http://proxy.example.com:8080',
      },
      mockConfigWithProxy,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        googleAuthOptions: expect.objectContaining({
          clientOptions: expect.objectContaining({
            transporterOptions: expect.objectContaining({
              agent: expect.any(HttpsProxyAgent),
            }),
          }),
        }),
      }),
    );
  });

  it.skip('should inject HttpProxyAgent when destination baseUrl uses http://', async () => {
    const mockConfigWithProxy = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue('http://proxy.example.com:8080'),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator);

    vi.stubEnv('GOOGLE_VERTEX_BASE_URL', 'http://localhost:9999');

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        vertexai: true,
        authType: AuthType.GATEWAY,
        proxy: 'http://proxy.example.com:8080',
      },
      mockConfigWithProxy,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        googleAuthOptions: expect.objectContaining({
          clientOptions: expect.objectContaining({
            transporterOptions: expect.objectContaining({
              agent: expect.any(HttpProxyAgent),
            }),
          }),
        }),
      }),
    );
  });

  it('should trim whitespace from proxy URL before instantiating agent', async () => {
    const mockConfigWithProxy = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue('  https://proxy.example.com:8080  '),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator);

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        vertexai: true,
        authType: AuthType.GATEWAY,
        proxy: '  https://proxy.example.com:8080  ',
      },
      mockConfigWithProxy,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        googleAuthOptions: expect.objectContaining({
          clientOptions: expect.objectContaining({
            transporterOptions: expect.objectContaining({
              agent: expect.any(HttpsProxyAgent),
            }),
          }),
        }),
      }),
    );
  });

  it('should not include googleAuthOptions when no proxy is configured', async () => {
    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator);

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        vertexai: true,
        authType: AuthType.GATEWAY,
      },
      mockConfig,
    );

    const callArg = vi.mocked(GoogleGenAI).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(callArg).not.toHaveProperty('googleAuthOptions');
  });

  it.skip('should pass api key as Authorization Header when GEMINI_API_KEY_AUTH_MECHANISM is set to bearer', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.stubEnv('GEMINI_API_KEY_AUTH_MECHANISM', 'bearer');

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: false,
      httpOptions: expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.any(String),
          Authorization: 'Bearer test-api-key',
        }),
      }),
    });
  });

  it('should not pass api key as Authorization Header when GEMINI_API_KEY_AUTH_MECHANISM is not set (default behavior)', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    // GEMINI_API_KEY_AUTH_MECHANISM is not stubbed, so it will be undefined, triggering default 'x-goog-api-key'

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: false,
      httpOptions: expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.any(String),
        }),
      }),
    });
    // Explicitly assert that Authorization header is NOT present
    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.not.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.any(String),
          }),
        }),
      }),
    );
  });

  it('should create a GoogleGenAI content generator with client install id logging disabled', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    const generator = await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );
    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: false,
      httpOptions: expect.objectContaining({
        headers: {
          'User-Agent': expect.any(String),
        },
      }),
    });
    expect(generator).toEqual(
      new LoggingContentGenerator(
        new ModelMappingContentGenerator(
          mockGenerator.models,
          expect.any(Function),
        ),
        mockConfig,
      ),
    );
  });

  it('should pass apiVersion to GoogleGenAI when GOOGLE_GENAI_API_VERSION is set', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.stubEnv('GOOGLE_GENAI_API_VERSION', 'v1');

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: false,
      httpOptions: expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.any(String),
        }),
      }),
      apiVersion: 'v1',
    });
  });

  it('should not include apiVersion when GOOGLE_GENAI_API_VERSION is not set', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: false,
      httpOptions: expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.any(String),
        }),
      }),
    });

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.not.objectContaining({
        apiVersion: expect.any(String),
      }),
    );
  });

  it('should not include apiVersion when GOOGLE_GENAI_API_VERSION is an empty string', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.stubEnv('GOOGLE_GENAI_API_VERSION', '');

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: false,
      httpOptions: expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.any(String),
        }),
      }),
    });

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.not.objectContaining({
        apiVersion: expect.any(String),
      }),
    );
  });

  it.skip('should pass apiVersion for Vertex AI when GOOGLE_GENAI_API_VERSION is set', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.stubEnv('GOOGLE_GENAI_API_VERSION', 'v1alpha');

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        vertexai: true,
        authType: AuthType.GATEWAY,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: true,
      httpOptions: expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.any(String),
        }),
      }),
      apiVersion: 'v1alpha',
    });
  });

  it.skip('should pass baseUrl to GoogleGenAI when GOOGLE_GEMINI_BASE_URL is set', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://gemini.test.local');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');

    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.AFOT_AUTH,
    );
    await createContentGenerator(config, mockConfig);

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-api-key',
        vertexai: false,
        httpOptions: expect.objectContaining({
          baseUrl: 'https://gemini.test.local',
        }),
      }),
    );
  });

  it.skip('should pass baseUrl to GoogleGenAI when GOOGLE_VERTEX_BASE_URL is set', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.stubEnv('GOOGLE_VERTEX_BASE_URL', 'https://vertex.test.local');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'my-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');

    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.GATEWAY,
    );
    await createContentGenerator(config, mockConfig);

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        vertexai: true,
        httpOptions: expect.objectContaining({
          baseUrl: 'https://vertex.test.local',
        }),
      }),
    );
  });

  it.skip('should prefer GOOGLE_VERTEX_BASE_URL when authType is USE_VERTEX_AI without inferred vertex credentials', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://gemini.test.local');
    vi.stubEnv('GOOGLE_VERTEX_BASE_URL', 'https://vertex.test.local');

    await createContentGenerator(
      {
        authType: AuthType.GATEWAY,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        vertexai: true,
        httpOptions: expect.objectContaining({
          baseUrl: 'https://vertex.test.local',
        }),
      }),
    );
  });

  it.skip('should inject apiEndpoint into googleAuthOptions.clientOptions when GOOGLE_VERTEX_BASE_URL is set', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.stubEnv('GOOGLE_VERTEX_BASE_URL', 'https://vertex.test.local');

    await createContentGenerator(
      {
        authType: AuthType.GATEWAY,
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        googleAuthOptions: expect.objectContaining({
          clientOptions: expect.objectContaining({
            apiEndpoint: 'https://vertex.test.local',
          }),
        }),
      }),
    );
  });

  it('should prefer an explicit baseUrl over GOOGLE_GEMINI_BASE_URL', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://env.test.local');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');

    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.AFOT_AUTH,
      undefined,
      'https://explicit.test.local',
    );
    await createContentGenerator(config, mockConfig);

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          baseUrl: 'https://explicit.test.local',
        }),
      }),
    );
  });

  it('should allow localhost baseUrl overrides over http', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);

    await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.AFOT_AUTH,
        baseUrl: 'http://127.0.0.1:8080',
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          baseUrl: 'http://127.0.0.1:8080',
        }),
      }),
    );
  });

  it('should reject invalid custom baseUrl values', async () => {
    await expect(
      createContentGenerator(
        {
          apiKey: 'test-api-key',
          authType: AuthType.AFOT_AUTH,
          baseUrl: 'not-a-url',
        },
        mockConfig,
      ),
    ).rejects.toThrow('Invalid custom base URL: not-a-url');
  });

  it('should set empty x-goog-api-key header for GATEWAY auth when apiKey is empty string', async () => {
    const mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getUsageStatisticsEnabled: () => false,
      getClientName: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);

    await createContentGenerator(
      {
        apiKey: '',
        authType: AuthType.GATEWAY,
        baseUrl: 'https://gateway.test.local',
      },
      mockConfig,
    );

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: '',
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            'x-goog-api-key': '',
          }),
        }),
      }),
    );
  });

  it('should not apply model mapping for Vertex AI', async () => {
    const mockModels = {
      generateContent: vi.fn().mockResolvedValue({}),
    };
    const mockGenerator = {
      models: mockModels,
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);

    const generator = await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.GATEWAY,
        vertexai: true,
      },
      mockConfig,
    );

    await generator.generateContent(
      {
        model: 'gemini-3-flash',
        contents: [],
      },
      'prompt-id',
      'user' as LlmRole,
    );

    expect(mockModels.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3-flash',
      }),
      'prompt-id',
      'user',
    );
  });

  it('should not apply model mapping for Gemini API', async () => {
    const mockModels = {
      generateContent: vi.fn().mockResolvedValue({}),
    };
    const mockGenerator = {
      models: mockModels,
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);

    const generator = await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );

    await generator.generateContent(
      {
        model: 'gemini-3-flash',
        contents: [],
      },
      'prompt-id',
      'user' as LlmRole,
    );

    expect(mockModels.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3-flash',
      }),
      'prompt-id',
      'user',
    );
  });

  it('should not apply model mapping for GATEWAY', async () => {
    const mockModels = {
      generateContent: vi.fn().mockResolvedValue({}),
    };
    const mockGenerator = {
      models: mockModels,
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);

    const generator = await createContentGenerator(
      {
        apiKey: 'test-api-key',
        authType: AuthType.GATEWAY,
      },
      mockConfig,
    );

    await generator.generateContent(
      {
        model: 'gemini-3.5-flash',
        contents: [],
      },
      'prompt-id',
      'user' as LlmRole,
    );

    expect(mockModels.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.5-flash',
      }),
      'prompt-id',
      'user',
    );
  });

  it.skip('should apply model mapping for LOGIN_WITH_GOOGLE', async () => {
    const mockInnerGenerator = {
      generateContent: vi.fn().mockResolvedValue({}),
    } as unknown as ContentGenerator;
    vi.mocked(createCodeAssistContentGenerator).mockResolvedValue(
      mockInnerGenerator as never,
    );

    const generator = await createContentGenerator(
      {
        authType: AuthType.AFOT_AUTH,
      },
      mockConfig,
    );

    await generator.generateContent(
      {
        model: 'gemini-3.5-flash',
        contents: [],
      },
      'prompt-id',
      'user' as LlmRole,
    );

    expect(mockInnerGenerator.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3-flash',
      }),
      'prompt-id',
      'user',
    );
  });

  it('should apply model mapping for COMPUTE_ADC', async () => {
    const mockInnerGenerator = {
      generateContent: vi.fn().mockResolvedValue({}),
    } as unknown as ContentGenerator;
    vi.mocked(createCodeAssistContentGenerator).mockResolvedValue(
      mockInnerGenerator as never,
    );

    const generator = await createContentGenerator(
      {
        authType: AuthType.COMPUTE_ADC,
      },
      mockConfig,
    );

    await generator.generateContent(
      {
        model: 'gemini-3.5-flash',
        contents: [],
      },
      'prompt-id',
      'user' as LlmRole,
    );

    expect(mockInnerGenerator.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3-flash',
      }),
      'prompt-id',
      'user',
    );
  });
});

describe('createContentGeneratorConfig', () => {
  const mockConfig = {
    getModel: vi.fn().mockReturnValue('gemini-pro'),
    setModel: vi.fn(),
    flashFallbackHandler: vi.fn(),
    getProxy: vi.fn(),
    getClientName: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

  beforeEach(() => {
    // Reset modules to re-evaluate imports and environment variables
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should configure for AFOT_AUTH using resolved provider', async () => {
    vi.mocked(resolveAfotProvider).mockReturnValue({
      name: 'openrouter',
      key: 'test-afot-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [],
    });
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.AFOT_AUTH,
    );
    expect(config.apiKey).toBe('test-afot-key');
    expect(config.vertexai).toBe(false);
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('should not configure for AFOT_AUTH if no provider resolved', async () => {
    vi.mocked(resolveAfotProvider).mockReturnValue(null);
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.AFOT_AUTH,
    );
    expect(config.apiKey).toBeUndefined();
    expect(config.vertexai).toBeUndefined();
  });

  it('should not configure for AFOT_AUTH if provider has no key', async () => {
    vi.mocked(resolveAfotProvider).mockReturnValue(null);
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.AFOT_AUTH,
    );
    expect(config.apiKey).toBeUndefined();
  });

  it('should configure for GATEWAY using provided apiKey', async () => {
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.GATEWAY,
      'custom-gateway-key',
    );
    expect(config.apiKey).toBe('custom-gateway-key');
    expect(config.vertexai).toBe(false);
  });

  it('should configure for GATEWAY using GEMINI_API_KEY env when no apiKey passed', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'env-gemini-key');
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.GATEWAY,
    );
    expect(config.apiKey).toBe('env-gemini-key');
    expect(config.vertexai).toBe(false);
  });

  it('should configure for GATEWAY with empty string key when nothing provided', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.GATEWAY,
    );
    expect(config.apiKey).toBe('');
    expect(config.vertexai).toBe(false);
  });

  it('should include routing settings in content generator config', async () => {
    const vertexAiRouting = {
      requestType: 'shared' as const,
      sharedRequestType: 'priority' as const,
    };

    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.GATEWAY,
      undefined,
      undefined,
      undefined,
      vertexAiRouting,
    );

    expect(config.vertexAiRouting).toEqual(vertexAiRouting);
  });

  it('should configure for GATEWAY using GEMINI_API_KEY from environment if set', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'env-gateway-key');
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.GATEWAY,
    );
    expect(config.apiKey).toBe('env-gateway-key');
    expect(config.vertexai).toBe(false);
  });

  it('should configure for GATEWAY using empty string if no apiKey is provided', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.GATEWAY,
    );
    expect(config.apiKey).toBe('');
    expect(config.vertexai).toBe(false);
  });
});
