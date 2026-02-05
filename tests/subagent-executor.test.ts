import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubagentExecutor, SubagentTaskSpec, ToolDefinition } from '../src/agent/subagent-executor.js';

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn(),
      },
    })),
  };
});

import Anthropic from '@anthropic-ai/sdk';

const createMockLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('SubagentExecutor', () => {
  let mockAnthropicClient: { messages: { create: ReturnType<typeof vi.fn> } };
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();

    // Get the mocked client instance
    mockAnthropicClient = {
      messages: {
        create: vi.fn(),
      },
    };

    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockAnthropicClient);
  });

  describe('Initialization', () => {
    it('should create executor with default config', () => {
      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
      });

      expect(executor).toBeInstanceOf(SubagentExecutor);
    });

    it('should use custom model when specified', async () => {
      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
        defaultModel: 'claude-3-haiku-20240307',
      });

      await executor.execute({ prompt: 'Hello' });

      expect(mockAnthropicClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-3-haiku-20240307',
        })
      );
    });

    it('should use custom maxTurns when specified', () => {
      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
        maxTurns: 5,
      });

      expect(executor).toBeDefined();
    });
  });

  describe('Basic Execution', () => {
    it('should execute simple prompt and return response', async () => {
      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Hello! How can I help you?' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
      });

      const result = await executor.execute({ prompt: 'Say hello' });

      expect(result.success).toBe(true);
      expect(result.response).toBe('Hello! How can I help you?');
      expect(result.turns).toBe(1);
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(20);
    });

    it('should include context summary in system prompt', async () => {
      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
      });

      await executor.execute({
        prompt: 'Do something',
        contextSummary: 'User is working on a Python project',
      });

      expect(mockAnthropicClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('Python project'),
        })
      );
    });

    it('should use spec model over default', async () => {
      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
        defaultModel: 'claude-3-haiku-20240307',
      });

      await executor.execute({
        prompt: 'Hello',
        model: 'claude-sonnet-4-20250514',
      });

      expect(mockAnthropicClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-20250514',
        })
      );
    });
  });

  describe('Tool Use', () => {
    it('should execute tools when Claude requests them', async () => {
      const toolHandler = vi.fn().mockResolvedValue('Tool result');

      const availableTools = new Map<string, ToolDefinition>([
        ['get_weather', {
          name: 'get_weather',
          description: 'Get weather for a location',
          inputSchema: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
          handler: toolHandler,
        }],
      ]);

      // First call returns tool use, second call returns final response
      mockAnthropicClient.messages.create
        .mockResolvedValueOnce({
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'get_weather', input: { location: 'NYC' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 20 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'The weather in NYC is sunny.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 30, output_tokens: 40 },
        });

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
        availableTools,
      });

      const result = await executor.execute({
        prompt: 'What is the weather in NYC?',
        tools: ['get_weather'],
      });

      expect(toolHandler).toHaveBeenCalledWith({ location: 'NYC' });
      expect(result.success).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('get_weather');
      expect(result.turns).toBe(2);
    });

    it('should handle tool errors gracefully', async () => {
      const toolHandler = vi.fn().mockRejectedValue(new Error('Tool failed'));

      const availableTools = new Map<string, ToolDefinition>([
        ['failing_tool', {
          name: 'failing_tool',
          description: 'A tool that fails',
          inputSchema: { type: 'object', properties: {} },
          handler: toolHandler,
        }],
      ]);

      mockAnthropicClient.messages.create
        .mockResolvedValueOnce({
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'failing_tool', input: {} },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 20 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'The tool failed, but I can continue.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 30, output_tokens: 40 },
        });

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
        availableTools,
      });

      const result = await executor.execute({
        prompt: 'Use the tool',
        tools: ['failing_tool'],
      });

      expect(result.success).toBe(true);
      expect(result.toolCalls[0].output).toContain('Tool failed');
    });

    it('should not include tools when not specified', async () => {
      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
      });

      await executor.execute({ prompt: 'Hello' });

      expect(mockAnthropicClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: undefined,
        })
      );
    });
  });

  describe('Turn Limits', () => {
    it('should stop after maxTurns reached', async () => {
      // Always return tool use to force multiple turns
      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'test_tool', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const availableTools = new Map<string, ToolDefinition>([
        ['test_tool', {
          name: 'test_tool',
          description: 'Test tool',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => 'result',
        }],
      ]);

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
        maxTurns: 3,
        availableTools,
      });

      const result = await executor.execute({
        prompt: 'Keep using tools',
        tools: ['test_tool'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Max turns');
      expect(result.turns).toBe(3);
    });

    it('should use spec maxTurns over default', async () => {
      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'test_tool', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const availableTools = new Map<string, ToolDefinition>([
        ['test_tool', {
          name: 'test_tool',
          description: 'Test tool',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => 'result',
        }],
      ]);

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
        maxTurns: 10,
        availableTools,
      });

      const result = await executor.execute({
        prompt: 'Keep using tools',
        tools: ['test_tool'],
        maxTurns: 2,
      });

      expect(result.turns).toBe(2);
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors', async () => {
      mockAnthropicClient.messages.create.mockRejectedValue(new Error('API Error'));

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
      });

      const result = await executor.execute({ prompt: 'Hello' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('API Error');
    });

    it('should handle unknown errors', async () => {
      mockAnthropicClient.messages.create.mockRejectedValue('String error');

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
      });

      const result = await executor.execute({ prompt: 'Hello' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('String error');
    });
  });

  describe('Events', () => {
    it('should emit text events', async () => {
      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Hello world' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
      });

      const textEvents: string[] = [];
      executor.on('text', (text) => textEvents.push(text));

      await executor.execute({ prompt: 'Say hello' });

      expect(textEvents).toContain('Hello world');
    });

    it('should emit turn events', async () => {
      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
      });

      const turnEvents: Array<{ turn: number; maxTurns: number }> = [];
      executor.on('turn', (data) => turnEvents.push(data));

      await executor.execute({ prompt: 'Hello' });

      expect(turnEvents).toHaveLength(1);
      expect(turnEvents[0].turn).toBe(1);
    });

    it('should emit tool_call and tool_result events', async () => {
      const availableTools = new Map<string, ToolDefinition>([
        ['test_tool', {
          name: 'test_tool',
          description: 'Test',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => 'tool output',
        }],
      ]);

      mockAnthropicClient.messages.create
        .mockResolvedValueOnce({
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'test_tool', input: { arg: 'value' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 20 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 30, output_tokens: 40 },
        });

      const executor = new SubagentExecutor({
        logger: logger as any,
        apiKey: 'test-key',
        availableTools,
      });

      const toolCallEvents: Array<{ name: string; input: unknown }> = [];
      const toolResultEvents: Array<{ name: string; result: string }> = [];

      executor.on('tool_call', (data) => toolCallEvents.push(data));
      executor.on('tool_result', (data) => toolResultEvents.push(data));

      await executor.execute({ prompt: 'Use tool', tools: ['test_tool'] });

      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0].name).toBe('test_tool');
      expect(toolResultEvents).toHaveLength(1);
      expect(toolResultEvents[0].result).toBe('tool output');
    });
  });

  describe('Static Factory', () => {
    it('should create executor with cluster tools', () => {
      const clusterTools = new Map([
        ['list_nodes', {
          description: 'List cluster nodes',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ nodes: [] }),
        }],
      ]);

      const executor = SubagentExecutor.withClusterTools(
        { logger: logger as any, apiKey: 'test-key' },
        clusterTools as any
      );

      expect(executor).toBeInstanceOf(SubagentExecutor);
    });
  });
});
