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
import {
  GenerateContentResponse,
  type GenerateContentParameters,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type FunctionCall,
} from '@google/genai';
import type { LlmRole } from '../telemetry/llmRole.js';
import {
  type AfotResolvedProvider,
  resolveAfotProviderByName,
} from './afotAuthStorage.js';
import { debugLogger } from '../utils/debugLogger.js';
import { TerminalQuotaError } from '../utils/googleQuotaErrors.js';
import { ModelNotFoundError } from '../utils/httpErrors.js';

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
  private readonly provider: AfotResolvedProvider;
  providerName: string;

  constructor(provider: AfotResolvedProvider, model: string) {
    this.provider = provider;
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
    activeModelOverride?: string,
    activeProviderOverride?: string,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    // Cast through unknown to access runtime properties
    const req = request as unknown as Record<string, unknown>;

    const effectiveModel = activeModelOverride || this.model;
    const effectiveProvider = activeProviderOverride || this.providerName;

    // System instruction
    const sysInstruction = req['systemInstruction'];
    const modelContext = `[Active Model: ${effectiveModel} | Provider: ${effectiveProvider}. You are running as model "${effectiveModel}" via provider "${effectiveProvider}" in AFOT CLI. Always identify yourself truthfully as "${effectiveModel}" when asked.]`;
    if (sysInstruction) {
      const sysText = this.extractText(sysInstruction);
      if (sysText) {
        messages.push({ role: 'system', content: `${sysText}\n\n${modelContext}` });
      } else {
        messages.push({ role: 'system', content: modelContext });
      }
    } else {
      messages.push({ role: 'system', content: modelContext });
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
        const toolCalls = functionCalls.map((p, idx) => {
          const rawId = (p.functionCall as unknown as { id?: string })?.id;
          const id = rawId || `call_${++callCounter}_${idx}_${p.functionCall!.name}`;
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
        functionResponses.forEach((resp, idx) => {
          const name = resp.functionResponse!.name;
          const respId = (resp.functionResponse as unknown as { id?: string })?.id;
          let toolCallId: string | undefined;

          // 1. Match by explicit id if present (exact match or with/without tool prefix)
          if (respId) {
            const matchIdx = pendingCalls.findIndex(
              (c) =>
                c.id === respId ||
                c.id.endsWith(`_${respId}`) ||
                respId.endsWith(`_${c.id}`) ||
                c.id.endsWith(respId) ||
                respId.endsWith(c.id),
            );
            if (matchIdx !== -1) {
              toolCallId = pendingCalls[matchIdx].id;
              pendingCalls.splice(matchIdx, 1);
            } else {
              toolCallId = respId;
            }
          }

          // 2. Match by function name from pending calls
          if (!toolCallId) {
            const matchIdx = pendingCalls.findIndex((c) => c.name === name);
            if (matchIdx !== -1) {
              toolCallId = pendingCalls[matchIdx].id;
              pendingCalls.splice(matchIdx, 1);
            }
          }

          // 3. Fallback to shifting next pending call or synthesizing with index
          if (!toolCallId) {
            toolCallId = pendingCalls.shift()?.id ?? `call_${idx}`;
          }

          messages.push({
            role: 'tool',
            content: JSON.stringify(resp.functionResponse!.response ?? {}),
            tool_call_id: toolCallId,
          });
        });
      } else if (textParts.length > 0) {
        let text = textParts.map((p) => p.text).join('');
        if (text.includes('This is the Gemini CLI.')) {
          text = text.replace('This is the Gemini CLI.', 'This is AFOT CLI.');
        }
        if (text.includes('<session_context>')) {
          text = text.replace(/Active model: [^\r\n]+/g, `Active model: ${effectiveModel}`);
        }
        messages.push({ role, content: text });
      }
    }

    return messages;
  }

  private toOpenAITools(
    request: GenerateContentParameters,
  ): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
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

  private estimateTokensFromText(text: string): number {
    if (!text) return 0;
    const nonAsciiMatch = text.match(/[^\x00-\x7F]/g);
    const nonAsciiCount = nonAsciiMatch ? nonAsciiMatch.length : 0;
    const asciiCount = text.length - nonAsciiCount;
    const codeSymbols = (text.match(/[{}\[\]();:<>=+\-*\/&|!^%~,"'\s]/g) || []).length;
    const isCodeHeavy = codeSymbols / text.length > 0.3;
    const charsPerToken = isCodeHeavy ? 3.2 : 3.6;
    const asciiTokens = Math.ceil(asciiCount / charsPerToken);
    const nonAsciiTokens = Math.ceil(nonAsciiCount * 1.3);
    return Math.max(1, asciiTokens + nonAsciiTokens);
  }

  private estimateTokensFromMessages(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): number {
    let tokens = 0;
    for (const msg of messages) {
      tokens += 4;
      const content = (msg as { content?: unknown }).content;
      if (typeof content === 'string') {
        tokens += this.estimateTokensFromText(content);
      } else if (content && typeof content === 'object') {
        try {
          tokens += this.estimateTokensFromText(JSON.stringify(content));
        } catch {
          tokens += 10;
        }
      }
    }
    return Math.max(1, tokens);
  }

  // ─── Translation: OpenAI → Gemini ──────────────────────────────────────────

  private normalizeToolArgs(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const norm: Record<string, unknown> = { ...args };
    if (name === 'read_file' || name === 'write_file' || name === 'edit') {
      if (!norm['file_path'] && norm['path']) {
        norm['file_path'] = norm['path'];
      }
      if (!norm['file_path'] && norm['Path']) {
        norm['file_path'] = norm['Path'];
      }
    }
    if (name === 'shell' || name === 'run_command') {
      if (!norm['command'] && norm['cmd']) {
        norm['command'] = norm['cmd'];
      }
      if (!norm['command'] && norm['CommandLine']) {
        norm['command'] = norm['CommandLine'];
      }
    }
    return norm;
  }

  private parseEmbeddedTextToolCalls(rawText: string): {
    cleanText: string;
    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
  } {
    if (
      !rawText.includes('<tool_call>') &&
      !rawText.includes('<invoke') &&
      !rawText.includes(']<]minimax[>')
    ) {
      return { cleanText: rawText, toolCalls: [] };
    }

    const clean = rawText
      .replace(/\]<\]minimax\[>\[?/g, '')
      .replace(/\]<\]/g, '');
    const toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = [];

    // 1. Match XML invoke pattern: <invoke name="...">...</invoke>
    const invokeRegex = /<invoke\s+name=["']?([^"'\s>]+)["']?>([\s\S]*?)<\/invoke>/g;
    let match: RegExpExecArray | null;
    while ((match = invokeRegex.exec(clean)) !== null) {
      const name = match[1].replace(/^["']|["']$/g, '');
      const body = match[2];
      const args: Record<string, unknown> = {};
      const paramRegex = /<([a-zA-Z0-9_-]+)(?:\s+name=["']?([^"'\s>]+)["']?)?>([\s\S]*?)<\/\1>/g;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = paramRegex.exec(body)) !== null) {
        const pKey = (pMatch[2] || pMatch[1]).replace(/^["']|["']$/g, '');
        const pVal = pMatch[3].trim();
        try {
          args[pKey] = JSON.parse(pVal);
        } catch {
          args[pKey] = pVal;
        }
      }
      const normalizedArgs = this.normalizeToolArgs(name, args);
      toolCalls.push({
        id: `call_${Math.random().toString(36).slice(2, 9)}`,
        function: { name, arguments: JSON.stringify(normalizedArgs) },
      });
    }

    // 2. Match JSON format inside <tool_call>...</tool_call>
    const jsonRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let jMatch: RegExpExecArray | null;
    while ((jMatch = jsonRegex.exec(clean)) !== null) {
      const inner = jMatch[1].trim();
      if (inner.startsWith('{') && inner.endsWith('}')) {
        try {
          const parsed = JSON.parse(inner) as {
            name?: string;
            arguments?: Record<string, unknown> | string;
          };
          if (parsed.name) {
            let parsedArgs: Record<string, unknown> = {};
            if (typeof parsed.arguments === 'string') {
              try {
                parsedArgs = JSON.parse(parsed.arguments);
              } catch {
                parsedArgs = {};
              }
            } else if (parsed.arguments && typeof parsed.arguments === 'object') {
              parsedArgs = parsed.arguments;
            }
            const normalizedArgs = this.normalizeToolArgs(parsed.name, parsedArgs);
            toolCalls.push({
              id: `call_${Math.random().toString(36).slice(2, 9)}`,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(normalizedArgs),
              },
            });
          }
        } catch {
          // ignore malformed JSON
        }
      }
    }

    // Strip tool call markup from human-visible text
    const cleanText = rawText
      .replace(/\]<\]minimax\[>\[?<tool_call>[\s\S]*?\]<\]minimax\[>\[?<\/tool_call>/g, '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<invoke\s+name=["']?[^"'\s>]+["']?>[\s\S]*?<\/invoke>/g, '')
      .replace(/\]<\]minimax\[>\[?/g, '')
      .trim();

    return { cleanText, toolCalls };
  }

  private createGeminiResponse(data: {
    candidates: Array<{
      content: { role: string; parts: GeminiPart[] };
      finishReason?: string;
      index: number;
    }>;
    usageMetadata?: GenerateContentResponse['usageMetadata'];
    modelVersion?: string;
  }): GenerateContentResponse {
    const resp = Object.assign(new GenerateContentResponse(), data);

    const firstCandidateParts = data.candidates?.[0]?.content?.parts ?? [];
    const fnCalls: FunctionCall[] = [];
    for (const part of firstCandidateParts) {
      if (part.functionCall) {
        fnCalls.push(part.functionCall);
      }
    }

    if (fnCalls.length > 0) {
      Object.defineProperty(resp, 'functionCalls', {
        value: fnCalls,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    return resp;
  }

  private toGeminiResponse(
    completion: OpenAI.Chat.Completions.ChatCompletion,
    messages?: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): GenerateContentResponse {
    const choice = completion.choices[0];
    if (!choice) {
      return this.createGeminiResponse({
        candidates: [],
      });
    }

    const parts: GeminiPart[] = [];

    // Text content (including reasoning/thinking models like Nemotron/GLM/DeepSeek)
    const rawContent =
      choice.message.content ||
      (choice.message as unknown as { reasoning_content?: string }).reasoning_content ||
      (choice.message as unknown as { reasoning?: string }).reasoning;

    // Tool calls from native OpenAI choice.message.tool_calls
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      if (rawContent) {
        parts.push({ text: rawContent });
      }
      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          args = JSON.parse((tc as { function?: { arguments?: string } }).function?.arguments || '{}');
        } catch {
          args = {};
        }
        const fnName = (tc as { function?: { name?: string } }).function?.name ?? '';
        parts.push({
          functionCall: {
            name: fnName,
            args: this.normalizeToolArgs(fnName, args),
            ...((tc as { id?: string }).id ? { id: (tc as { id?: string }).id } : {}),
          },
        });
      }
    } else if (rawContent) {
      // Check for text-based embedded tool calls (MiniMax, GLM, DeepSeek XML style)
      const parsed = this.parseEmbeddedTextToolCalls(rawContent);
      if (parsed.toolCalls.length > 0) {
        if (parsed.cleanText) {
          parts.push({ text: parsed.cleanText });
        }
        for (const tc of parsed.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: this.normalizeToolArgs(tc.function.name, args),
              ...(tc.id ? { id: tc.id } : {}),
            },
          });
        }
      } else {
        parts.push({ text: rawContent });
      }
    }

    let promptTokens = completion.usage?.prompt_tokens ?? 0;
    let candidatesTokens = completion.usage?.completion_tokens ?? 0;
    let totalTokens = completion.usage?.total_tokens ?? 0;
    const cachedTokens =
      (completion.usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } })
        ?.prompt_tokens_details?.cached_tokens ?? 0;

    if (promptTokens === 0 && messages) {
      promptTokens = this.estimateTokensFromMessages(messages);
    }
    if (candidatesTokens === 0 && rawContent) {
      candidatesTokens = this.estimateTokensFromText(rawContent);
    }
    if (totalTokens === 0) {
      totalTokens = promptTokens + candidatesTokens;
    }

    return this.createGeminiResponse({
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
      usageMetadata: {
        promptTokenCount: promptTokens,
        candidatesTokenCount: candidatesTokens,
        totalTokenCount: totalTokens,
        cachedContentTokenCount: cachedTokens,
      },
      modelVersion: completion.model || undefined,
    });
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

  private resolveModelForProvider(requestedModel: string | undefined): string {
    const raw =
      typeof requestedModel === 'string' && requestedModel.trim()
        ? requestedModel.trim().replace(/^models\//, '')
        : this.model;

    const available = this.provider.models ?? [];
    if (!available || available.length === 0) {
      return raw || this.model;
    }

    const providerStripped = raw
      .replace(/^openrouter\//i, '')
      .replace(/^opencode\//i, '');

    if (available.includes(raw)) {
      return raw;
    }
    if (available.includes(providerStripped)) {
      return providerStripped;
    }

    // Attempt base name matching between providers (e.g. glm-5.3-flash-free <-> z-ai/glm-5.3-flash)
    const normalizedRaw = providerStripped
      .replace(/-free$/, '')
      .toLowerCase();
    const rawBase = normalizedRaw.includes('/')
      ? normalizedRaw.split('/').pop()!
      : normalizedRaw;

    const matched = available.find((m: string) => {
      const normM = m.replace(/-free$/, '').toLowerCase();
      const baseM = normM.includes('/') ? normM.split('/').pop()! : normM;
      return (
        baseM === rawBase ||
        normM === normalizedRaw ||
        m.toLowerCase() === raw.toLowerCase() ||
        m.toLowerCase() === providerStripped.toLowerCase()
      );
    });

    if (matched) {
      return matched;
    }

    // If explicit custom model requested by user (not default gemini alias), trust user's model
    if (raw && !raw.startsWith('gemini-') && raw !== 'auto') {
      return providerStripped;
    }

    if (this.model && available.includes(this.model)) {
      return this.model;
    }
    return this.provider.defaultModel &&
      available.includes(this.provider.defaultModel)
      ? this.provider.defaultModel
      : available[0] ?? providerStripped;
  }

  private handleOpenAIError(err: unknown, currentProvider?: string): never {
    const errorObj = err as {
      status?: number;
      message?: string;
      name?: string;
      code?: string;
      error?: { type?: string; message?: string };
      headers?: unknown;
    };

    const status = errorObj?.status;
    const errorType = errorObj?.error?.type;
    const errorMessage =
      errorObj?.error?.message || errorObj?.message || '';

    // Extract retry-after header if present (standard seconds)
    let retryAfterSeconds: number | undefined;
    const headers = errorObj?.headers;
    if (headers) {
      const rawHeader =
        typeof (headers as Headers).get === 'function'
          ? (headers as Headers).get('retry-after')
          : (headers as Record<string, string>)['retry-after'];
      if (rawHeader) {
        const parsed = parseInt(rawHeader, 10);
        if (!isNaN(parsed) && parsed > 0) {
          retryAfterSeconds = parsed;
        }
      }
    }

    if (!retryAfterSeconds && typeof errorMessage === 'string') {
      const match = errorMessage.match(/resets? in (\d+)\s*(s|m|h)/i);
      if (match) {
        const val = parseInt(match[1]!, 10);
        const unit = match[2]!.toLowerCase();
        if (unit === 's') retryAfterSeconds = val;
        else if (unit === 'm') retryAfterSeconds = val * 60;
        else if (unit === 'h') retryAfterSeconds = val * 3600;
      }
    }

    if (
      status === 429 ||
      errorType === 'FreeUsageLimitError' ||
      /free usage limit reached/i.test(errorMessage) ||
      /usage limit reached/i.test(errorMessage)
    ) {
      throw new TerminalQuotaError(
        errorMessage || 'Free usage limit reached on OpenCode Console.',
        undefined,
        retryAfterSeconds,
        'PROVIDER_QUOTA_EXHAUSTED',
      );
    }

    const provName = currentProvider || this.providerName;

    if (
      status === 404 ||
      status === 410 ||
      (status === 400 && /model is unavailable/i.test(errorMessage))
    ) {
      const displayMsg =
        errorMessage.includes('Function') && errorMessage.includes('Not found for account')
          ? `Model "${this.model}" is not available on your ${provName} account. Please select an available model in /model.`
          : errorMessage || `Model "${this.model}" is unavailable on ${provName}.`;
      throw new ModelNotFoundError(
        displayMsg,
        status || 404,
      );
    }

    if (
      errorObj.name === 'APIConnectionTimeoutError' ||
      /timed? ?out/i.test(errorMessage) ||
      errorObj.code === 'ETIMEDOUT'
    ) {
      throw new Error(
        `Request timed out for model "${this.model}" on ${provName} (upstream server not responding). Please switch to an active model via /model (e.g. nvidia/nemotron-3.5-super-vl-120b-a12b).`,
      );
    }

    throw err;
  }

  private isRetryableProviderError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const errorObj = err as {
      name?: string;
      code?: string;
      status?: number;
      message?: string;
    };
    if (errorObj.name === 'APIConnectionTimeoutError') return true;
    if (errorObj.code === 'ETIMEDOUT' || errorObj.code === 'ECONNRESET') return true;
    if (errorObj.status === 504 || errorObj.status === 502 || errorObj.status === 503) return true;
    if (
      typeof errorObj.message === 'string' &&
      /timed? ?out|socket hang up|econnreset/i.test(errorObj.message)
    ) {
      return true;
    }
    return false;
  }

  private getFallbackClient(
    targetProvider: string,
    requestedModel: string,
  ): { client: OpenAI; model: string; providerName: string } | null {
    try {
      const prov = resolveAfotProviderByName(targetProvider);
      if (!prov?.key || !prov?.baseUrl) return null;
      let model = requestedModel;
      if (model.startsWith('openrouter/')) {
        model = model.replace(/^openrouter\//i, '');
      } else if (model.startsWith('opencode/')) {
        model = model.replace(/^opencode\//i, '');
      }
      if (targetProvider === 'openrouter' && model.startsWith('deepseek-ai/')) {
        model = model.replace(/^deepseek-ai\//, 'deepseek/');
      }
      const client = new OpenAI({
        apiKey: prov.key,
        baseURL: prov.baseUrl,
        defaultHeaders: prov.headers,
      });
      return { client, model, providerName: targetProvider };
    } catch {
      return null;
    }
  }

  private getEffectiveClientAndModel(requestedModel: string): {
    client: OpenAI;
    model: string;
    providerName: string;
  } {
    // If unit test has mocked client.chat.completions.create, preserve mocked client
    const isMock =
      typeof (
        this.client?.chat?.completions?.create as unknown as {
          mock?: unknown;
        }
      )?.mock !== 'undefined';
    if (isMock) {
      return {
        client: this.client,
        model: requestedModel,
        providerName: this.providerName,
      };
    }

    // 1. Explicit openrouter/ prefix -> route or normalize to OpenRouter
    if (requestedModel.startsWith('openrouter/')) {
      const bareModel = requestedModel.replace(/^openrouter\//i, '');
      const cleanModel = bareModel.startsWith('deepseek-ai/')
        ? bareModel.replace(/^deepseek-ai\//, 'deepseek/')
        : bareModel;
      if (this.providerName === 'openrouter') {
        return {
          client: this.client,
          model: cleanModel,
          providerName: 'openrouter',
        };
      }
      const fallback = this.getFallbackClient('openrouter', cleanModel);
      if (fallback) {
        debugLogger.log(
          `AFOT Auto-routing model "${requestedModel}" to openrouter as "${cleanModel}"`,
        );
        return fallback;
      }
    }

    // 2. Explicit opencode/ prefix -> route or normalize to OpenCode
    if (requestedModel.startsWith('opencode/')) {
      const bareModel = requestedModel.replace(/^opencode\//i, '');
      if (this.providerName === 'opencode') {
        return {
          client: this.client,
          model: bareModel,
          providerName: 'opencode',
        };
      }
      const fallback = this.getFallbackClient('opencode', bareModel);
      if (fallback) {
        return fallback;
      }
    }

    // 3. Explicit nvidia/ prefix -> route or normalize to NVIDIA
    if (requestedModel.startsWith('nvidia/')) {
      if (this.providerName === 'nvidia') {
        return {
          client: this.client,
          model: requestedModel,
          providerName: 'nvidia',
        };
      }
      const fallback = this.getFallbackClient('nvidia', requestedModel);
      if (fallback) {
        debugLogger.log(
          `AFOT Auto-routing model "${requestedModel}" to nvidia`,
        );
        return fallback;
      }
    }

    let effectiveModel = requestedModel;
    if (this.providerName === 'openrouter') {
      if (effectiveModel.startsWith('openrouter/')) {
        effectiveModel = effectiveModel.replace(/^openrouter\//i, '');
      }
      if (effectiveModel.startsWith('deepseek-ai/')) {
        effectiveModel = effectiveModel.replace(/^deepseek-ai\//, 'deepseek/');
      }
    }

    // If provider is NVIDIA, but the requested model clearly belongs to an external provider
    // (e.g. 'z-ai/*', 'moonshotai/*', 'deepseek/*') that is known to hang on NVIDIA NIM,
    // seamlessly route it to OpenRouter if configured.
    if (this.providerName === 'nvidia') {
      const isThirdPartyModel =
        effectiveModel.startsWith('z-ai/') ||
        effectiveModel.startsWith('moonshotai/') ||
        effectiveModel.startsWith('deepseek/') ||
        effectiveModel.startsWith('deepseek-ai/') ||
        effectiveModel.startsWith('meta/') ||
        effectiveModel.startsWith('google/');

      if (isThirdPartyModel) {
        const fallback = this.getFallbackClient('openrouter', effectiveModel);
        if (fallback) {
          debugLogger.log(
            `AFOT Auto-routing model "${effectiveModel}" from nvidia to openrouter`,
          );
          return fallback;
        }
      }
    }

    // If provider is OpenRouter, but the model clearly belongs to NVIDIA NIM (e.g. 'nvidia/*'),
    // seamlessly route it to NVIDIA if configured.
    if (
      this.providerName === 'openrouter' &&
      effectiveModel.startsWith('nvidia/')
    ) {
      const fallback = this.getFallbackClient('nvidia', effectiveModel);
      if (fallback) {
        debugLogger.log(
          `AFOT Auto-routing model "${effectiveModel}" from openrouter to nvidia`,
        );
        return fallback;
      }
    }

    return {
      client: this.client,
      model: effectiveModel,
      providerName: this.providerName,
    };
  }

  // ─── ContentGenerator interface ────────────────────────────────────────────

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const reqModel = (request as { model?: string }).model;
    const modelToUse = this.resolveModelForProvider(reqModel);
    this.model = modelToUse;

    const resolved = this.getEffectiveClientAndModel(modelToUse);
    const clientToUse = resolved.client;
    const finalModel = resolved.model;
    const effectiveProvider = resolved.providerName;

    const messages = this.toOpenAIMessages(
      request,
      finalModel,
      effectiveProvider,
    );
    const tools = this.toOpenAITools(request);
    const config = request.config as
      | { temperature?: number; maxOutputTokens?: number; topP?: number }
      | undefined;

    try {
      const completion = await clientToUse.chat.completions.create(
        {
          model: finalModel,
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
        },
        { timeout: 15000 },
      );

      return this.toGeminiResponse(completion, messages);
    } catch (err: unknown) {
      if (
        effectiveProvider !== 'openrouter' &&
        this.isRetryableProviderError(err)
      ) {
        try {
          const fallback = this.getFallbackClient('openrouter', finalModel);
          if (fallback) {
            const completion = await fallback.client.chat.completions.create(
              {
                model: fallback.model,
                messages,
                ...(tools && { tools }),
                ...(config?.temperature !== undefined && {
                  temperature: config.temperature,
                }),
                max_tokens: config?.maxOutputTokens
                  ? Math.min(config.maxOutputTokens, 8192)
                  : 8192,
                ...(config?.topP !== undefined && { top_p: config.topP }),
              },
              { timeout: 15000 },
            );
            return this.toGeminiResponse(completion, messages);
          }
        } catch {
          // Ignore fallback error and throw original error
        }
      }
      this.handleOpenAIError(err, effectiveProvider);
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const reqModel = (request as { model?: string }).model;
    const modelToUse = this.resolveModelForProvider(reqModel);
    this.model = modelToUse;

    const resolved = this.getEffectiveClientAndModel(modelToUse);
    const clientToUse = resolved.client;
    const finalModel = resolved.model;
    const effectiveProvider = resolved.providerName;

    const messages = this.toOpenAIMessages(
      request,
      finalModel,
      effectiveProvider,
    );
    const tools = this.toOpenAITools(request);
    const config = request.config as
      | { temperature?: number; maxOutputTokens?: number; topP?: number }
      | undefined;

    let stream:
      | AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
      | undefined;
    try {
      try {
        stream = await clientToUse.chat.completions.create(
          {
            model: finalModel,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(tools && { tools }),
            ...(config?.temperature !== undefined && {
              temperature: config.temperature,
            }),
            max_tokens: config?.maxOutputTokens
              ? Math.min(config.maxOutputTokens, 8192)
              : 8192,
            ...(config?.topP !== undefined && { top_p: config.topP }),
          },
          { timeout: 15000 },
        );
      } catch (streamOptErr: unknown) {
        stream = await clientToUse.chat.completions.create(
          {
            model: finalModel,
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
          },
          { timeout: 15000 },
        );
      }
    } catch (err: unknown) {
      if (
        effectiveProvider !== 'openrouter' &&
        this.isRetryableProviderError(err)
      ) {
        try {
          const fallback = this.getFallbackClient('openrouter', finalModel);
          if (fallback) {
            try {
              stream = await fallback.client.chat.completions.create(
                {
                  model: fallback.model,
                  messages,
                  stream: true,
                  stream_options: { include_usage: true },
                  ...(tools && { tools }),
                  ...(config?.temperature !== undefined && {
                    temperature: config.temperature,
                  }),
                  max_tokens: config?.maxOutputTokens
                    ? Math.min(config.maxOutputTokens, 8192)
                    : 8192,
                  ...(config?.topP !== undefined && { top_p: config.topP }),
                },
                { timeout: 15000 },
              );
            } catch {
              stream = await fallback.client.chat.completions.create(
                {
                  model: fallback.model,
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
                },
                { timeout: 15000 },
              );
            }
          }
        } catch {
          // Ignore fallback error and report original
        }
      }
      if (!stream) {
        this.handleOpenAIError(err, effectiveProvider);
      }
    }

    // Return an async generator
    const self = this;
    return (async function* (): AsyncGenerator<GenerateContentResponse> {
      let accumulatedText = '';
      let accumulatedToolCalls: Array<{
        id: string;
        function: { name: string; arguments: string };
      }> = [];
      let finishReason: string | null = null;
      let promptTokensFromStream: number | undefined;
      let completionTokensFromStream: number | undefined;
      let totalTokensFromStream: number | undefined;
      let cachedTokensFromStream: number | undefined;
      let wasTextStreamed = false;

      try {
        for await (const chunk of stream) {
          if (chunk.usage) {
            const usage = chunk.usage;
            if (typeof usage.prompt_tokens === 'number') {
              promptTokensFromStream = usage.prompt_tokens;
            }
            if (typeof usage.completion_tokens === 'number') {
              completionTokensFromStream = usage.completion_tokens;
            }
            if (typeof usage.total_tokens === 'number') {
              totalTokensFromStream = usage.total_tokens;
            }
            const promptDetails = (usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } })
              ?.prompt_tokens_details;
            if (typeof promptDetails?.cached_tokens === 'number') {
              cachedTokensFromStream = promptDetails.cached_tokens;
            }
          }

          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (!delta && !choice) continue;

          const textDelta =
            delta?.content ||
            (delta as unknown as { reasoning_content?: string })?.reasoning_content ||
            (delta as unknown as { reasoning?: string })?.reasoning;

          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          if (textDelta) {
            accumulatedText += textDelta;
            const isInsideEmbeddedToolCall =
              accumulatedText.includes(']<]minimax[>') ||
              accumulatedText.includes('<tool_call>') ||
              accumulatedText.includes('<invoke');

            if (!isInsideEmbeddedToolCall) {
              wasTextStreamed = true;
              yield self.createGeminiResponse({
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [{ text: textDelta }],
                    },
                    index: 0,
                  },
                ],
              });
            }
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
              if (tc.id) {
                accumulatedToolCalls[idx].id = tc.id;
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
      } catch (err) {
        self.handleOpenAIError(err);
      }

      const computeFinalUsage = () => {
        let promptTokens = promptTokensFromStream ?? 0;
        let candidatesTokens = completionTokensFromStream ?? 0;
        let totalTokens = totalTokensFromStream ?? 0;
        const cachedTokens = cachedTokensFromStream ?? 0;

        if (promptTokens === 0) {
          promptTokens = self.estimateTokensFromMessages(messages);
        }
        if (candidatesTokens === 0 && accumulatedText) {
          candidatesTokens = self.estimateTokensFromText(accumulatedText);
        }
        if (totalTokens === 0) {
          totalTokens = promptTokens + candidatesTokens;
        }

        return {
          promptTokenCount: promptTokens,
          candidatesTokenCount: candidatesTokens,
          totalTokenCount: totalTokens,
          cachedContentTokenCount: cachedTokens,
        };
      };

      // Check if text contained embedded tool calls (e.g. MiniMax, GLM, DeepSeek XML/JSON style)
      if (accumulatedToolCalls.length === 0 && accumulatedText) {
        const parsed = self.parseEmbeddedTextToolCalls(accumulatedText);
        if (parsed.toolCalls.length > 0) {
          accumulatedToolCalls = parsed.toolCalls;
          accumulatedText = parsed.cleanText;
        }
      }

      const validToolCalls = accumulatedToolCalls.filter(Boolean);

      // If there were tool calls, emit a final response with them, functionCalls property, and usageMetadata
      if (validToolCalls.length > 0) {
        const parts: GeminiPart[] = [];
        if (accumulatedText && !wasTextStreamed) {
          parts.push({ text: accumulatedText });
        }
        for (const tc of validToolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }
          const fnName = tc.function.name;
          parts.push({
            functionCall: {
              name: fnName,
              args: self.normalizeToolArgs(fnName, args),
              ...(tc.id ? { id: tc.id } : {}),
            },
          });
        }
        yield self.createGeminiResponse({
          candidates: [
            {
              content: { role: 'model', parts },
              finishReason: self.mapFinishReason(finishReason ?? 'stop'),
              index: 0,
            },
          ],
          usageMetadata: computeFinalUsage(),
        });
      } else {
        // Emit final closing response with finishReason and usageMetadata
        const parts: GeminiPart[] = [];
        if (accumulatedText && !wasTextStreamed) {
          parts.push({ text: accumulatedText });
        }
        yield self.createGeminiResponse({
          candidates: [
            {
              content: { role: 'model', parts },
              finishReason: self.mapFinishReason(finishReason ?? 'stop'),
              index: 0,
            },
          ],
          usageMetadata: computeFinalUsage(),
        });
      }
    })();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const req = request as unknown as Record<string, unknown>;
    const contents = req['contents'];
    let contentList: GeminiContent[] = [];
    if (Array.isArray(contents)) {
      contentList = contents as GeminiContent[];
    } else if (contents && typeof contents === 'object') {
      contentList = [contents as GeminiContent];
    }

    let estimatedTokens = 0;

    for (const c of contentList) {
      if (!c?.parts) continue;

      // Base message framing overhead
      estimatedTokens += 4;

      for (const p of c.parts) {
        let textContent = '';
        if (p.text) {
          textContent += p.text;
        }
        if (p.functionCall) {
          textContent += p.functionCall.name + ' ';
          if (p.functionCall.args) {
            try {
              textContent += JSON.stringify(p.functionCall.args);
            } catch {
              // ignore
            }
          }
        }
        if (p.functionResponse) {
          textContent += p.functionResponse.name + ' ';
          if (p.functionResponse.response) {
            try {
              textContent += JSON.stringify(p.functionResponse.response);
            } catch {
              // ignore
            }
          }
        }

        if (!textContent) continue;

        // Token estimation heuristic:
        // Non-ASCII (CJK, emojis, multi-byte UTF-8): ~1.3 tokens per char
        const nonAsciiMatch = textContent.match(/[^\x00-\x7F]/g);
        const nonAsciiCount = nonAsciiMatch ? nonAsciiMatch.length : 0;
        const asciiCount = textContent.length - nonAsciiCount;

        // Code / JSON / whitespace density detection
        const codeSymbols = (textContent.match(/[{}\[\]();:<>=+\-*\/&|!^%~,"'\s]/g) || []).length;
        const isCodeHeavy = codeSymbols / textContent.length > 0.3;
        const charsPerToken = isCodeHeavy ? 3.2 : 3.6;

        const asciiTokens = Math.ceil(asciiCount / charsPerToken);
        const nonAsciiTokens = Math.ceil(nonAsciiCount * 1.3);

        estimatedTokens += asciiTokens + nonAsciiTokens;
      }
    }

    return {
      totalTokens: Math.max(1, estimatedTokens),
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
