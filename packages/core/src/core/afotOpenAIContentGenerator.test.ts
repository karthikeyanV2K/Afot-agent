/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { AfotOpenAIContentGenerator } from './afotOpenAIContentGenerator.js';
import type { GenerateContentParameters } from '@google/genai';
import { LlmRole } from '../telemetry/llmRole.js';

vi.mock('../utils/debugLogger.js', () => ({
  debugLogger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('AfotOpenAIContentGenerator', () => {
  const provider = {
    name: 'nvidia',
    key: 'nvapi-test-key',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['z-ai/glm-5.3-flash', 'nvidia/llama-3.1-nemotron-70b-instruct'],
    defaultModel: 'z-ai/glm-5.3-flash',
  };

  it('preserves and resolves user requested models without forced redirect', async () => {
    const generator = new AfotOpenAIContentGenerator(provider, 'z-ai/glm-5.3-flash');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved1 = (generator as any).resolveModelForProvider('glm-5.3-flash');
    expect(resolved1).toBe('z-ai/glm-5.3-flash');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved2 = (generator as any).resolveModelForProvider('z-ai/glm-5.3-flash');
    expect(resolved2).toBe('z-ai/glm-5.3-flash');

    // Custom model not in catalog should be trusted directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolvedCustom = (generator as any).resolveModelForProvider('brand-new-model');
    expect(resolvedCustom).toBe('brand-new-model');
  });

  it('yields usageMetadata from stream chunks in generateContentStream', async () => {
    const generator = new AfotOpenAIContentGenerator(provider, 'z-ai/glm-5.3-flash');

    // Mock client.chat.completions.create
    const mockStream = (async function* () {
      yield {
        id: 'chunk-1',
        choices: [
          {
            index: 0,
            delta: { content: 'Hello' },
            finish_reason: null,
          },
        ],
      };
      yield {
        id: 'chunk-2',
        choices: [
          {
            index: 0,
            delta: { content: ' world!' },
            finish_reason: 'stop',
          },
        ],
      };
      // Trailing usage-only chunk (choices empty)
      yield {
        id: 'chunk-3',
        choices: [],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 4,
          total_tokens: 19,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      };
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (generator as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockStream),
        },
      },
    };

    const req: GenerateContentParameters = {
      model: 'z-ai/glm-5.3-flash',
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };

    const stream = await generator.generateContentStream(req, 'prompt-1', LlmRole.MAIN);
    const responses = [];
    for await (const chunk of stream) {
      responses.push(chunk);
    }

    expect(responses.length).toBeGreaterThan(0);
    const finalChunk = responses[responses.length - 1];
    expect(finalChunk.usageMetadata).toBeDefined();
    expect(finalChunk.usageMetadata?.promptTokenCount).toBe(15);
    expect(finalChunk.usageMetadata?.candidatesTokenCount).toBe(4);
    expect(finalChunk.usageMetadata?.totalTokenCount).toBe(19);
    expect(finalChunk.usageMetadata?.cachedContentTokenCount).toBe(5);
  });

  it('estimates usageMetadata when stream does not provide usage', async () => {
    const generator = new AfotOpenAIContentGenerator(provider, 'z-ai/glm-5.3-flash');

    const mockStream = (async function* () {
      yield {
        id: 'chunk-1',
        choices: [
          {
            index: 0,
            delta: { content: 'This is a test response without server usage.' },
            finish_reason: 'stop',
          },
        ],
      };
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (generator as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockStream),
        },
      },
    };

    const req: GenerateContentParameters = {
      model: 'z-ai/glm-5.3-flash',
      contents: [{ role: 'user', parts: [{ text: 'Calculate something for me please' }] }],
    };

    const stream = await generator.generateContentStream(req, 'prompt-1', LlmRole.MAIN);
    const responses = [];
    for await (const chunk of stream) {
      responses.push(chunk);
    }

    const finalChunk = responses[responses.length - 1];
    expect(finalChunk.usageMetadata).toBeDefined();
    expect(finalChunk.usageMetadata?.promptTokenCount).toBeGreaterThan(0);
    expect(finalChunk.usageMetadata?.candidatesTokenCount).toBeGreaterThan(0);
    expect(finalChunk.usageMetadata?.totalTokenCount).toBeGreaterThan(0);
  });

  it('correctly parses text-based embedded tool calls from MiniMax and XML-style models', async () => {
    const generator = new AfotOpenAIContentGenerator(provider, 'minimaxai/minimax-m3.1-flash');
    const raw = `I will read the files now.]<]minimax[>[<tool_call>
]<]minimax[>[<invoke name="read_file">]<]minimax[>[<path>X:\\Afot-os\\AGENTS.md]<]minimax[>[</path>]<]minimax[>[</invoke>
]<]minimax[>[<invoke name="read_file">]<]minimax[>[<path>X:\\Afot-os\\README.md]<]minimax[>[</path>]<]minimax[>[</invoke>
]<]minimax[>[</tool_call>`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = (generator as any).parseEmbeddedTextToolCalls(raw);
    expect(parsed.cleanText).toBe('I will read the files now.');
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.toolCalls[0].function.name).toBe('read_file');
    expect(JSON.parse(parsed.toolCalls[0].function.arguments)).toEqual({
      file_path: 'X:\\Afot-os\\AGENTS.md',
      path: 'X:\\Afot-os\\AGENTS.md',
    });
    expect(parsed.toolCalls[1].function.name).toBe('read_file');
    expect(JSON.parse(parsed.toolCalls[1].function.arguments)).toEqual({
      file_path: 'X:\\Afot-os\\README.md',
      path: 'X:\\Afot-os\\README.md',
    });
  });

  it('updates dynamic model identity and sanitizes session context', () => {
    const generator = new AfotOpenAIContentGenerator(provider, 'initial-model');
    const req: GenerateContentParameters = {
      model: 'z-ai/glm-5.3-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: '<session_context>\nActive model: old-stale-model\nOS: win32\n</session_context>',
            },
          ],
        },
      ],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = (generator as any).toOpenAIMessages(req, 'z-ai/glm-5.3-flash');
    const sysMsg = messages.find((m: { role: string }) => m.role === 'system');
    expect(sysMsg?.content).toContain('[Active Model: z-ai/glm-5.3-flash | Provider: nvidia');
    expect(sysMsg?.content).toContain('You are running as model "z-ai/glm-5.3-flash"');

    const userMsg = messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg?.content).toContain('Active model: z-ai/glm-5.3-flash');
    expect(userMsg?.content).not.toContain('Active model: old-stale-model');
  });

  it('throws ModelNotFoundError when a model returns 404 without silent fallback', async () => {
    const generator = new AfotOpenAIContentGenerator(provider, 'moonshotai/kimi-k2.6');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (generator as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue({
            status: 404,
            message: "Function 'xyz': Not found for account 'acc'",
          }),
        },
      },
    };

    const req: GenerateContentParameters = {
      model: 'moonshotai/kimi-k2.6',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    };

    await expect(generator.generateContent(req, 'prompt-1', LlmRole.MAIN)).rejects.toThrow(
      /is not available on your nvidia account/,
    );
  });

  it('identifies retryable provider timeout and connection errors', () => {
    const generator = new AfotOpenAIContentGenerator(provider, 'z-ai/glm-5.3-flash');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isRetryable = (generator as any).isRetryableProviderError.bind(generator);

    expect(isRetryable({ name: 'APIConnectionTimeoutError' })).toBe(true);
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryable({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryable({ status: 504 })).toBe(true);
    expect(isRetryable({ message: 'socket hang up' })).toBe(true);
    expect(isRetryable({ status: 404 })).toBe(false);
    expect(isRetryable({ status: 401 })).toBe(false);
  });

  it('emits functionCalls property on GenerateContentResponse in generateContentStream when model calls tools', async () => {
    const generator = new AfotOpenAIContentGenerator(provider, 'z-ai/glm-5.3-flash');

    const mockStream = (async function* () {
      yield {
        id: 'chunk-1',
        choices: [
          {
            index: 0,
            delta: { content: "I'll analyze the codebase." },
            finish_reason: null,
          },
        ],
      };
      yield {
        id: 'chunk-2',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_123',
                  type: 'function',
                  function: { name: 'list_directory', arguments: '{"path":".' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      yield {
        id: 'chunk-3',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (generator as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockStream),
        },
      },
    };

    const req: GenerateContentParameters = {
      model: 'z-ai/glm-5.3-flash',
      contents: [{ role: 'user', parts: [{ text: 'analize full code base' }] }],
    };

    const stream = await generator.generateContentStream(req, 'prompt-tools', LlmRole.MAIN);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(2);
    // Chunk 0: text streamed delta
    expect(chunks[0].candidates?.[0]?.content?.parts?.[0]?.text).toBe("I'll analyze the codebase.");
    expect(chunks[0].functionCalls).toBeUndefined();

    // Chunk 1: final tool call chunk
    const toolChunk = chunks[1];
    expect(toolChunk.functionCalls).toBeDefined();
    expect(toolChunk.functionCalls).toHaveLength(1);
    expect(toolChunk.functionCalls?.[0]?.id).toBe('call_123');
    expect(toolChunk.functionCalls?.[0]?.name).toBe('list_directory');
    expect(toolChunk.functionCalls?.[0]?.args).toEqual({ path: '.' });

    // Ensure streamed text is not duplicated in the final tool call chunk
    const hasDuplicateText = toolChunk.candidates?.[0]?.content?.parts?.some((p) => p.text);
    expect(hasDuplicateText).toBeFalsy();
  });

  it('emits functionCalls property in non-streaming generateContent when model calls tools', async () => {
    const generator = new AfotOpenAIContentGenerator(provider, 'z-ai/glm-5.3-flash');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (generator as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            id: 'comp-1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Reading file...',
                  tool_calls: [
                    {
                      id: 'call_456',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'README.md' }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 15,
              total_tokens: 25,
            },
          }),
        },
      },
    };

    const req: GenerateContentParameters = {
      model: 'z-ai/glm-5.3-flash',
      contents: [{ role: 'user', parts: [{ text: 'read README.md' }] }],
    };

    const response = await generator.generateContent(req, 'prompt-non-stream', LlmRole.MAIN);
    expect(response.functionCalls).toBeDefined();
    expect(response.functionCalls).toHaveLength(1);
    expect(response.functionCalls?.[0]?.id).toBe('call_456');
    expect(response.functionCalls?.[0]?.name).toBe('read_file');
    expect(response.functionCalls?.[0]?.args).toEqual({
      path: 'README.md',
      file_path: 'README.md',
    });
  });

  it('provides tool definitions in toOpenAITools for both nvidia and openrouter', () => {
    const generator = new AfotOpenAIContentGenerator(provider, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
    const req = {
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'list_directory',
                description: 'Lists files in directory',
                parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
              },
            ],
          },
        ],
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (generator as any).toOpenAITools(req);
    expect(tools).toBeDefined();
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe('list_directory');
  });
});
