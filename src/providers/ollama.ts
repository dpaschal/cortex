import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamChunk, ContentBlock, ToolDefinition, ToolCall } from './types.js';
import { randomUUID } from 'crypto';

function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
}

// Ollama/OpenAI tool format
interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaProviderConfig {
  baseUrl?: string;
  model?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: OllamaProviderConfig) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
    this.defaultModel = config.model ?? 'llama3';
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const ollamaMessages = this.convertMessages(messages, options?.systemPrompt);
    const ollamaTools = options?.tools ? this.convertTools(options.tools) : undefined;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.model ?? this.defaultModel,
        messages: ollamaMessages,
        stream: false,
        ...(ollamaTools && ollamaTools.length > 0 ? { tools: ollamaTools } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      message: {
        role: string;
        content: string;
        tool_calls?: OllamaToolCall[];
      };
      model: string;
      eval_count?: number;
      prompt_eval_count?: number;
    };

    // Parse tool calls from response
    let toolCalls: ToolCall[] | undefined;
    if (data.message.tool_calls && data.message.tool_calls.length > 0) {
      toolCalls = data.message.tool_calls.map(tc => ({
        id: randomUUID(),
        name: tc.function.name,
        input: typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      }));
    }

    return {
      content: data.message.content ?? '',
      model: data.model,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      toolCalls,
    };
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const ollamaMessages = this.convertMessages(messages, options?.systemPrompt);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.model ?? this.defaultModel,
        messages: ollamaMessages,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean);
      for (const line of lines) {
        const data = JSON.parse(line) as { message?: { content: string }; done: boolean };
        if (data.message?.content) {
          yield { content: data.message.content, done: data.done };
        }
        if (data.done) {
          yield { content: '', done: true };
          return;
        }
      }
    }
  }

  async models(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json() as { models: Array<{ name: string }> };
    return data.models.map(m => m.name);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Convert our ToolDefinition[] to Ollama/OpenAI tool format.
   */
  private convertTools(tools: ToolDefinition[]): OllamaTool[] {
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  /**
   * Convert our ChatMessage[] to Ollama message format.
   *
   * Handles:
   * - System messages → { role: 'system', content }
   * - Plain text messages → { role, content }
   * - Assistant messages with tool_use blocks → { role: 'assistant', content, tool_calls }
   * - User messages with tool_result blocks → multiple { role: 'tool', content } messages
   */
  private convertMessages(messages: ChatMessage[], systemPrompt?: string): OllamaMessage[] {
    const result: OllamaMessage[] = [];

    // Prepend system prompt if provided
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Skip if we already prepended a systemPrompt
        if (!systemPrompt) {
          result.push({ role: 'system', content: contentToString(msg.content) });
        }
        continue;
      }

      if (typeof msg.content === 'string') {
        result.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
        continue;
      }

      // ContentBlock[] — check what types of blocks are present
      const blocks = msg.content;
      const textBlocks = blocks.filter(b => b.type === 'text');
      const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');
      const toolResultBlocks = blocks.filter(b => b.type === 'tool_result');

      if (msg.role === 'assistant' && toolUseBlocks.length > 0) {
        // Assistant message with tool calls
        const textContent = textBlocks.map(b => b.text ?? '').join('');
        const toolCalls: OllamaToolCall[] = toolUseBlocks.map(b => ({
          function: {
            name: b.name!,
            arguments: b.input ?? {},
          },
        }));
        result.push({
          role: 'assistant',
          content: textContent,
          tool_calls: toolCalls,
        });
      } else if (toolResultBlocks.length > 0) {
        // Tool results → one 'tool' message per result
        for (const block of toolResultBlocks) {
          result.push({
            role: 'tool',
            content: block.content ?? '',
          });
        }
      } else {
        // Plain content blocks
        result.push({
          role: msg.role as 'user' | 'assistant',
          content: textBlocks.map(b => b.text ?? '').join(''),
        });
      }
    }

    return result;
  }
}
