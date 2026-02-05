import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'events';
import { Logger } from 'winston';

export interface SubagentTaskSpec {
  prompt: string;
  model?: string;
  tools?: string[];
  contextSummary?: string;
  maxTurns?: number;
}

export interface SubagentResult {
  success: boolean;
  response: string;
  toolCalls: ToolCallRecord[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  output: string;
  timestamp: number;
}

export interface SubagentExecutorConfig {
  logger: Logger;
  apiKey?: string;
  defaultModel?: string;
  maxTurns?: number;
  availableTools?: Map<string, ToolDefinition>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (input: Record<string, unknown>) => Promise<string>;
}

export class SubagentExecutor extends EventEmitter {
  private client: Anthropic;
  private config: SubagentExecutorConfig;
  private defaultModel: string;
  private maxTurns: number;

  constructor(config: SubagentExecutorConfig) {
    super();
    this.config = config;
    this.defaultModel = config.defaultModel ?? 'claude-sonnet-4-20250514';
    this.maxTurns = config.maxTurns ?? 10;

    // Initialize Anthropic client
    this.client = new Anthropic({
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
  }

  async execute(spec: SubagentTaskSpec): Promise<SubagentResult> {
    const model = spec.model ?? this.defaultModel;
    const maxTurns = spec.maxTurns ?? this.maxTurns;
    const toolCalls: ToolCallRecord[] = [];

    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    // Build system prompt with context summary
    let systemPrompt = 'You are a helpful AI assistant executing a task as part of a distributed compute cluster.';
    if (spec.contextSummary) {
      systemPrompt += `\n\nContext from the requesting session:\n${spec.contextSummary}`;
    }

    // Get available tools
    const tools = this.getToolsForSpec(spec);

    // Build initial messages
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: spec.prompt }
    ];

    this.config.logger.info('Starting subagent execution', {
      model,
      maxTurns,
      toolCount: tools.length,
      promptLength: spec.prompt.length,
    });

    try {
      while (turns < maxTurns) {
        turns++;

        this.emit('turn', { turn: turns, maxTurns });

        // Call Claude API
        const response = await this.client.messages.create({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages,
          tools: tools.length > 0 ? tools : undefined,
        });

        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;

        // Emit streaming-like updates
        for (const block of response.content) {
          if (block.type === 'text') {
            this.emit('text', block.text);
          }
        }

        // Check if we need to handle tool use
        if (response.stop_reason === 'tool_use') {
          const toolUseBlocks = response.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
          );

          // Add assistant message with tool use
          messages.push({ role: 'assistant', content: response.content });

          // Execute tools and collect results
          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const toolUse of toolUseBlocks) {
            this.emit('tool_call', { name: toolUse.name, input: toolUse.input });

            const result = await this.executeTool(toolUse.name, toolUse.input as Record<string, unknown>);

            toolCalls.push({
              name: toolUse.name,
              input: toolUse.input as Record<string, unknown>,
              output: result,
              timestamp: Date.now(),
            });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result,
            });

            this.emit('tool_result', { name: toolUse.name, result });
          }

          // Add tool results
          messages.push({ role: 'user', content: toolResults });

          // Continue the loop for next turn
          continue;
        }

        // End turn - extract final response
        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === 'text'
        );
        const finalResponse = textBlocks.map(b => b.text).join('\n');

        this.config.logger.info('Subagent execution completed', {
          turns,
          inputTokens,
          outputTokens,
          toolCalls: toolCalls.length,
        });

        return {
          success: true,
          response: finalResponse,
          toolCalls,
          turns,
          inputTokens,
          outputTokens,
        };
      }

      // Max turns reached
      const lastMessage = messages[messages.length - 1];
      const partialResponse = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : 'Max turns reached without completion';

      this.config.logger.warn('Subagent max turns reached', { turns, maxTurns });

      return {
        success: false,
        response: partialResponse,
        toolCalls,
        turns,
        inputTokens,
        outputTokens,
        error: `Max turns (${maxTurns}) reached without completion`,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.config.logger.error('Subagent execution failed', { error: errorMessage });

      return {
        success: false,
        response: '',
        toolCalls,
        turns,
        inputTokens,
        outputTokens,
        error: errorMessage,
      };
    }
  }

  private getToolsForSpec(spec: SubagentTaskSpec): Anthropic.Tool[] {
    if (!spec.tools || spec.tools.length === 0 || !this.config.availableTools) {
      return [];
    }

    const tools: Anthropic.Tool[] = [];

    for (const toolName of spec.tools) {
      const toolDef = this.config.availableTools.get(toolName);
      if (toolDef) {
        tools.push({
          name: toolDef.name,
          description: toolDef.description,
          input_schema: toolDef.inputSchema as Anthropic.Tool['input_schema'],
        });
      }
    }

    return tools;
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    const toolDef = this.config.availableTools?.get(name);

    if (!toolDef) {
      return JSON.stringify({ error: `Tool '${name}' not found` });
    }

    try {
      const result = await toolDef.handler(input);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: errorMessage });
    }
  }

  // Create executor with cluster tools
  static withClusterTools(
    config: Omit<SubagentExecutorConfig, 'availableTools'>,
    clusterTools: Map<string, { description: string; inputSchema: object; handler: (args: Record<string, unknown>) => Promise<unknown> }>
  ): SubagentExecutor {
    const availableTools = new Map<string, ToolDefinition>();

    for (const [name, tool] of clusterTools) {
      availableTools.set(name, {
        name,
        description: tool.description,
        inputSchema: tool.inputSchema as ToolDefinition['inputSchema'],
        handler: async (input) => {
          const result = await tool.handler(input);
          return typeof result === 'string' ? result : JSON.stringify(result);
        },
      });
    }

    return new SubagentExecutor({ ...config, availableTools });
  }
}
