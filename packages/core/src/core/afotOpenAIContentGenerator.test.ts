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
});
