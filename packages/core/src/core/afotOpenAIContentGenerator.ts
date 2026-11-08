/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AFOT OpenAI-Compatible Content Generator
 *
 * Implements the ContentGenerator interface using the `openai` npm package,
 * allowing AFOT to work with any OpenAI-compatible provider (OpenRouter,
 * NVIDIA, Anthropic via proxy, Groq, Together, etc.).
 *
 * Translates between Gemini API format (used throughout the codebase) and
 * OpenAI API format (used by most third-party providers).
 */

import OpenAI from 'openai';
import type {
  ContentGenerator,
} from './contentGenerator.js';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
} from '@google/genai';
import type { LlmRole } from '../telemetry/llmRole.js';
import type { AfotResolvedProvider } from './afotAuthStorage.js';
import { debugLogger } from '../utils/debugLogger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { data: string; mimeType: string };
  thought?: boolean;
}

interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parametersJsonSchema?: Record<string, unknown>;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class AfotOpenAIContentGenerator implements ContentGenerator {
  private client: OpenAI;
  private model: string;
  providerName: string;

  constructor(provider: AfotResolvedProvider, model: string) {
    this.client = new OpenAI({
      apiKey: provider.key,
      baseURL: provider.baseUrl,
      defaultHeaders: provider.headers,
    });
    this.model = model;
    this.providerName = provider.name;
    debugLogger.log(
      `AFOT OpenAI ContentGenerator: provider=${provider.name}, model=${model}, baseUrl=${provider.baseUrl}`,
    );
  }

  // ─── Translation: Gemini → OpenAI ─────────────────────────────────────────

  private toOpenAIMessages(
    request: GenerateContentParameters,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    // Cast through unknown to access runtime properties
    const req = request as unknown as Record<string, unknown>;

    // System instruction
    const sysInstruction = req['systemInstruction'];
    if (sysInstruction) {
      const sysText = this.extractText(sysInstruction);
      if (sysText) {
        messages.push({ role: 'system', content: sysText });
      }
    }

    // Contents → messages
    const rawContents = req['contents'];
    let contentList: GeminiContent[] = [];
    if (Array.isArray(rawContents)) {
      contentList = rawContents as GeminiContent[];
    } else if (typeof rawContents === 'string') {
      contentList = [{ role: 'user', parts: [{ text: rawContents }] }];
    } else if (rawContents && typeof rawContents === 'object') {
      contentList = [rawContents as GeminiContent];
    }

    let callCounter = 0;
    const pendingCalls: Array<{ name: string; id: string }> = [];

    for (const content of contentList) {
      if (!content?.parts) continue;

      const role = content.role === 'model' ? 'assistant' : 'user';

      // Check for function calls (assistant messages with tool calls)
      const functionCalls = content.parts.filter((p) => p.functionCall);
      const functionResponses = content.parts.filter((p) => p.functionResponse);
      const textParts = content.parts.filter((p) => p.text !== undefined);

      if (functionCalls.length > 0) {
        const toolCalls = functionCalls.map((p) => {
          const id = `call_${++callCounter}_${p.functionCall!.name}`;
          pendingCalls.push({ name: p.functionCall!.name, id });
          return {
            id,
            type: 'function' as const,
            function: {
              name: p.functionCall!.name,
              arguments: JSON.stringify(p.functionCall!.args ?? {}),
            },
          };
        });
        messages.push({
          role: 'assistant',
          content: textParts.map((p) => p.text).join('') || null,
          tool_calls: toolCalls,
        });
      } else if (functionResponses.length > 0) {
        for (const resp of functionResponses) {
          const name = resp.functionResponse!.name;
          const matchIdx = pendingCalls.findIndex((c) => c.name === name);
          let toolCallId: string;
          if (matchIdx !== -1) {
            toolCallId = pendingCalls[matchIdx].id;
            pendingCalls.splice(matchIdx, 1);
          } else {
            toolCallId =
              pendingCalls.shift()?.id ?? `call_${++callCounter}_${name}`;
          }
          messages.push({
            role: 'tool',
            content: JSON.stringify(resp.functionResponse!.response ?? {}),
            tool_call_id: toolCallId,
          });
        }
      } else if (textParts.length > 0) {
        const text = textParts.map((p) => p.text).join('');
        messages.push({ role, content: text });
      }
    }

    return messages;
  }

  private toOpenAITools(
    request: GenerateContentParameters,
  ): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
    if (this.providerName === 'nvidia') {
      return undefined;
    }
    const config = request.config as
      | { tools?: Array<{ functionDeclarations?: GeminiFunctionDeclaration[] }> }
      | undefined;

    const declarations = config?.tools?.flatMap(
      (t) => t.functionDeclarations ?? [],
    );

    if (!declarations?.length) return undefined;

    return declarations.map((d) => ({
      type: 'function' as const,
      function: {
        name: d.name,
        description: d.description ?? '',
        parameters: (d.parametersJsonSchema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {},
        },
      },
    }));
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    const c = content as GeminiContent;
    if (c?.parts) {
      return c.parts.map((p) => p.text ?? '').join('');
    }
    return '';
  }

  // ─── Translation: OpenAI → Gemini ──────────────────────────────────────────

  private toGeminiResponse(
    completion: OpenAI.Chat.Completions.ChatCompletion,
  ): GenerateContentResponse {
    const choice = completion.choices[0];
    if (!choice) {
      return {
        candidates: [],
      } as unknown as GenerateContentResponse;
    }

    const parts: GeminiPart[] = [];

    // Text content (including reasoning/thinking models like Nemotron/GLM/DeepSeek)
    const rawContent =
      choice.message.content ||
      (choice.message as unknown as { reasoning_content?: string }).reasoning_content ||
      (choice.message as unknown as { reasoning?: string }).reasoning;
    if (rawContent) {
      parts.push({ text: rawContent });
    }

    // Tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          args = JSON.parse((tc as { function?: { arguments?: string } }).function?.arguments || '{}');
        } catch {
          args = {};
        }
        parts.push({
          functionCall: {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            name: (tc as { function?: { name?: string } }).function?.name ?? '',
            args,
          },
        });
      }
    }

    return {
      candidates: [
        {
          content: {
            role: 'model',
            parts,
          },
          finishReason: this.mapFinishReason(choice.finish_reason),
          index: 0,
        },
      ],
      usageMetadata: completion.usage
        ? {
            promptTokenCount: completion.usage.prompt_tokens ?? 0,
            candidatesTokenCount: completion.usage.completion_tokens ?? 0,
            totalTokenCount: completion.usage.total_tokens ?? 0,
          }
        : undefined,
    } as unknown as GenerateContentResponse;
  }

  private mapFinishReason(
    reason: string | null,
  ): string {
    switch (reason) {
      case 'stop':
        return 'STOP';
      case 'length':
        return 'MAX_TOKENS';
      case 'tool_calls':
        return 'STOP';
      case 'content_filter':
        return 'SAFETY';
      default:
        return 'STOP';
    }
  }

  // ─── ContentGenerator interface ────────────────────────────────────────────

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const messages = this.toOpenAIMessages(request);
    const tools = this.toOpenAITools(request);
    const config = request.config as { temperature?: number; maxOutputTokens?: number; topP?: number } | undefined;
    const reqModel = (request as { model?: string }).model;
    const modelToUse =
      typeof reqModel === 'string' && reqModel.trim()
        ? reqModel.trim().replace(/^models\//, '')
        : this.model;

    const completion = await this.client.chat.completions.create({
      model: modelToUse,
      messages,
      ...(tools && { tools }),
      ...(config?.temperature !== undefined && {
        temperature: config.temperature,
      }),
      // Cap max_tokens to 8192 by default — many providers reject Gemini's
      // default of 65536 unless you have sufficient credits/quota
      max_tokens: config?.maxOutputTokens
        ? Math.min(config.maxOutputTokens, 8192)
        : 8192,
      ...(config?.topP !== undefined && { top_p: config.topP }),
    });

    return this.toGeminiResponse(completion);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const messages = this.toOpenAIMessages(request);
    const tools = this.toOpenAITools(request);
    const config = request.config as { temperature?: number; maxOutputTokens?: number; topP?: number } | undefined;
    const reqModel = (request as { model?: string }).model;
    const modelToUse =
      typeof reqModel === 'string' && reqModel.trim()
        ? reqModel.trim().replace(/^models\//, '')
        : this.model;

    const stream = await this.client.chat.completions.create({
      model: modelToUse,
      messages,
      stream: true,
      ...(tools && { tools }),
      ...(config?.temperature !== undefined && {
        temperature: config.temperature,
      }),
      max_tokens: config?.maxOutputTokens
        ? Math.min(config.maxOutputTokens, 8192)
        : 8192,
      ...(config?.topP !== undefined && { top_p: config.topP }),
    });

    // Return an async generator
    const self = this;
    return (async function* (): AsyncGenerator<GenerateContentResponse> {
      let accumulatedText = '';
      let accumulatedToolCalls: Array<{
        id: string;
        function: { name: string; arguments: string };
      }> = [];
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (!delta && !choice) continue;

        const textDelta =
          delta?.content ||
          (delta as unknown as { reasoning_content?: string })?.reasoning_content ||
          (delta as unknown as { reasoning?: string })?.reasoning;

        const chunkFinishReason = choice?.finish_reason
          ? self.mapFinishReason(choice.finish_reason)
          : undefined;

        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        if (textDelta || chunkFinishReason) {
          if (textDelta) {
            accumulatedText += textDelta;
          }
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: textDelta ? [{ text: textDelta }] : [],
                },
                ...(chunkFinishReason && { finishReason: chunkFinishReason }),
                index: 0,
              },
            ],
          } as unknown as GenerateContentResponse;
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!accumulatedToolCalls[idx]) {
              accumulatedToolCalls[idx] = {
                id: tc.id ?? `call_${idx}`,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                function: { name: (tc as { function?: { name?: string } }).function?.name ?? '', arguments: '' },
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const tcFunc = (tc as { function?: { name?: string; arguments?: string } }).function;
            if (tcFunc?.name) {
              accumulatedToolCalls[idx].function.name = tcFunc.name;
            }
            if (tcFunc?.arguments) {
              accumulatedToolCalls[idx].function.arguments += tcFunc.arguments;
            }
          }
        }
      }

      // If there were tool calls, emit a final response with them
      if (accumulatedToolCalls.length > 0) {
        const parts: GeminiPart[] = [];
        if (accumulatedText) parts.push({ text: accumulatedText });
        for (const tc of accumulatedToolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }
          parts.push({
            functionCall: { name: tc.function.name, args },
          });
        }
        yield {
          candidates: [
            {
              content: { role: 'model', parts },
              finishReason: self.mapFinishReason(finishReason ?? 'stop'),
              index: 0,
            },
          ],
        } as unknown as GenerateContentResponse;
      } else if (!finishReason) {
        // Guarantee at least one finish reason is emitted so geminiChat stream validation passes
        yield {
          candidates: [
            {
              content: { role: 'model', parts: [] },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        } as unknown as GenerateContentResponse;
      }
    })();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // Approximate: 1 token ≈ 4 chars
    const req = request as unknown as Record<string, unknown>;
    const contents = req['contents'];
    let contentList: GeminiContent[] = [];
    if (Array.isArray(contents)) {
      contentList = contents as GeminiContent[];
    } else if (contents && typeof contents === 'object') {
      contentList = [contents as GeminiContent];
    }
    let totalChars = 0;
    for (const c of contentList) {
      if (c?.parts) {
        for (const p of c.parts) {
          if (p.text) totalChars += p.text.length;
        }
      }
    }
    return {
      totalTokens: Math.ceil(totalChars / 4),
    } as unknown as CountTokensResponse;
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    // Stub — most providers support embeddings separately
    throw new Error('embedContent not supported via AFOT OpenAI adapter');
  }

  userTier = undefined;
  userTierName = undefined;
  paidTier = undefined;
}
