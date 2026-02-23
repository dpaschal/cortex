// src/messaging/__tests__/conversation.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationHandler } from '../conversation.js';
import type { LLMProvider, ChatMessage, ChatResponse, ChatOptions, StreamChunk } from '../../providers/types.js';
import type { ToolHandler } from '../../plugins/types.js';
import type { ChannelMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    channelType: 'telegram',
    channelId: 'chat-1',
    userId: 'user-1',
    username: 'alice',
    content: 'hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function textResponse(content: string): ChatResponse {
  return {
    content,
    model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 20 },
    stopReason: 'end_turn',
  };
}

function toolResponse(content: string, toolCalls: ChatResponse['toolCalls']): ChatResponse {
  return {
    content,
    model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 20 },
    stopReason: 'tool_use',
    toolCalls,
  };
}

function createMockProvider(chatFn: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>): LLMProvider {
  return {
    name: 'mock',
    chat: chatFn,
    stream: async function* (): AsyncGenerator<StreamChunk> {
      yield { content: '', done: true };
    },
    models: async () => ['test-model'],
    isAvailable: async () => true,
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import('winston').Logger;
}

function createToolHandler(result: unknown): ToolHandler {
  return {
    description: 'A test tool',
    inputSchema: {
      type: 'object' as const,
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
    handler: vi.fn().mockResolvedValue(result),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationHandler', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  // -------------------------------------------------------------------------
  // 1. Basic text message -> text response (no tools)
  // -------------------------------------------------------------------------
  describe('basic text exchange', () => {
    it('should return text response for a simple message', async () => {
      const provider = createMockProvider(async () => textResponse('Hi there!'));
      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
      });

      const result = await handler.handleMessage(makeMessage({ content: 'Hello' }));
      expect(result).toBe('Hi there!');
    });

    it('should pass systemPrompt and no tools when tools map is empty', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('ok'));
      const provider = createMockProvider(chatFn);
      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
        agentName: 'TestBot',
      });

      await handler.handleMessage(makeMessage());
      expect(chatFn).toHaveBeenCalledTimes(1);
      const [_msgs, options] = chatFn.mock.calls[0];
      expect(options.systemPrompt).toContain('TestBot');
      expect(options.tools).toBeUndefined();
    });

    it('should use custom systemPrompt when provided', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('ok'));
      const provider = createMockProvider(chatFn);
      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
        systemPrompt: 'You are a custom bot.',
      });

      await handler.handleMessage(makeMessage());
      const [_msgs, options] = chatFn.mock.calls[0];
      expect(options.systemPrompt).toBe('You are a custom bot.');
    });

    it('should include user message in the chat history sent to provider', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('reply'));
      const provider = createMockProvider(chatFn);
      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
      });

      await handler.handleMessage(makeMessage({ content: 'What is 2+2?' }));
      const [messages] = chatFn.mock.calls[0];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: 'user', content: 'What is 2+2?' });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Message triggering tool use -> tool execution -> response
  // -------------------------------------------------------------------------
  describe('tool execution', () => {
    it('should execute a tool call and return final response', async () => {
      let callCount = 0;
      const provider = createMockProvider(async () => {
        callCount++;
        if (callCount === 1) {
          return toolResponse('Let me check...', [
            { id: 'call-1', name: 'get_status', input: {} },
          ]);
        }
        return textResponse('The cluster is healthy.');
      });

      const statusTool = createToolHandler({ status: 'healthy', nodes: 6 });
      const tools = new Map<string, ToolHandler>([['get_status', statusTool]]);

      const handler = new ConversationHandler({ provider, tools, logger });
      const result = await handler.handleMessage(makeMessage({ content: 'Check cluster status' }));

      expect(result).toBe('The cluster is healthy.');
      expect(statusTool.handler).toHaveBeenCalledWith({});
    });

    it('should pass tool definitions to the provider', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('ok'));
      const provider = createMockProvider(chatFn);
      const tools = new Map<string, ToolHandler>([
        ['my_tool', createToolHandler('result')],
      ]);

      const handler = new ConversationHandler({ provider, tools, logger });
      await handler.handleMessage(makeMessage());

      const [_msgs, options] = chatFn.mock.calls[0];
      expect(options.tools).toHaveLength(1);
      expect(options.tools![0].name).toBe('my_tool');
      expect(options.tools![0].description).toBe('A test tool');
    });

    it('should build correct assistant and user messages for tool loop', async () => {
      const chatFn = vi.fn();
      chatFn.mockResolvedValueOnce(
        toolResponse('Checking...', [{ id: 'tc-1', name: 'get_status', input: { node: 'forge' } }])
      );
      chatFn.mockResolvedValueOnce(textResponse('All good.'));

      const provider = createMockProvider(chatFn);
      const tools = new Map<string, ToolHandler>([
        ['get_status', createToolHandler({ ok: true })],
      ]);

      const handler = new ConversationHandler({ provider, tools, logger });
      await handler.handleMessage(makeMessage({ content: 'status' }));

      // Second call should have: user msg, assistant (tool_use blocks), user (tool_result blocks)
      const [secondCallMsgs] = chatFn.mock.calls[1];
      expect(secondCallMsgs).toHaveLength(3);

      // Assistant message with tool_use blocks
      const assistantMsg = secondCallMsgs[1];
      expect(assistantMsg.role).toBe('assistant');
      expect(Array.isArray(assistantMsg.content)).toBe(true);
      const blocks = assistantMsg.content as import('../../providers/types.js').ContentBlock[];
      expect(blocks[0]).toEqual({ type: 'text', text: 'Checking...' });
      expect(blocks[1]).toEqual({
        type: 'tool_use',
        id: 'tc-1',
        name: 'get_status',
        input: { node: 'forge' },
      });

      // User message with tool_result blocks
      const toolResultMsg = secondCallMsgs[2];
      expect(toolResultMsg.role).toBe('user');
      expect(Array.isArray(toolResultMsg.content)).toBe(true);
      const resultBlocks = toolResultMsg.content as import('../../providers/types.js').ContentBlock[];
      expect(resultBlocks[0].type).toBe('tool_result');
      expect(resultBlocks[0].tool_use_id).toBe('tc-1');
      expect(resultBlocks[0].content).toBe('{"ok":true}');
    });

    it('should not include text block in assistant message when content is empty', async () => {
      const chatFn = vi.fn();
      chatFn.mockResolvedValueOnce(
        toolResponse('', [{ id: 'tc-1', name: 'get_status', input: {} }])
      );
      chatFn.mockResolvedValueOnce(textResponse('Done.'));

      const provider = createMockProvider(chatFn);
      const tools = new Map<string, ToolHandler>([
        ['get_status', createToolHandler({ ok: true })],
      ]);

      const handler = new ConversationHandler({ provider, tools, logger });
      await handler.handleMessage(makeMessage());

      const [secondCallMsgs] = chatFn.mock.calls[1];
      const assistantMsg = secondCallMsgs[1];
      const blocks = assistantMsg.content as import('../../providers/types.js').ContentBlock[];
      // Should only have tool_use block, no text block for empty content
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('tool_use');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Multi-turn tool loop (tool calls chain)
  // -------------------------------------------------------------------------
  describe('multi-turn tool loop', () => {
    it('should handle multiple rounds of tool calls', async () => {
      const chatFn = vi.fn();
      // Round 1: call tool A
      chatFn.mockResolvedValueOnce(
        toolResponse('Listing nodes...', [{ id: 'tc-1', name: 'list_nodes', input: {} }])
      );
      // Round 2: call tool B based on result from A
      chatFn.mockResolvedValueOnce(
        toolResponse('Getting details...', [{ id: 'tc-2', name: 'get_node', input: { id: 'forge' } }])
      );
      // Round 3: final text response
      chatFn.mockResolvedValueOnce(textResponse('Forge has 10 cores and 32GB RAM.'));

      const provider = createMockProvider(chatFn);
      const tools = new Map<string, ToolHandler>([
        ['list_nodes', createToolHandler(['forge', 'anvil'])],
        ['get_node', createToolHandler({ cores: 10, ram: '32GB' })],
      ]);

      const handler = new ConversationHandler({ provider, tools, logger });
      const result = await handler.handleMessage(makeMessage({ content: 'Tell me about forge' }));

      expect(result).toBe('Forge has 10 cores and 32GB RAM.');
      expect(chatFn).toHaveBeenCalledTimes(3);
      expect(tools.get('list_nodes')!.handler).toHaveBeenCalledTimes(1);
      expect(tools.get('get_node')!.handler).toHaveBeenCalledWith({ id: 'forge' });
    });
  });

  // -------------------------------------------------------------------------
  // 4. Max iterations limit
  // -------------------------------------------------------------------------
  describe('max iterations limit', () => {
    it('should stop the tool loop after maxToolIterations', async () => {
      const chatFn = vi.fn().mockResolvedValue(
        toolResponse('Still working...', [{ id: 'tc-x', name: 'infinite_tool', input: {} }])
      );

      const provider = createMockProvider(chatFn);
      const tools = new Map<string, ToolHandler>([
        ['infinite_tool', createToolHandler({ more: true })],
      ]);

      const handler = new ConversationHandler({
        provider,
        tools,
        logger,
        maxToolIterations: 3,
      });

      const result = await handler.handleMessage(makeMessage());

      // provider.chat called: 1 initial + 3 iterations = 4 times
      expect(chatFn).toHaveBeenCalledTimes(4);
      // Returns whatever text the LLM produced in the last response
      expect(result).toBe('Still working...');
    });

    it('should log a warning when max iterations reached', async () => {
      const chatFn = vi.fn().mockResolvedValue(
        toolResponse('looping', [{ id: 'tc-x', name: 'loop_tool', input: {} }])
      );

      const provider = createMockProvider(chatFn);
      const tools = new Map<string, ToolHandler>([
        ['loop_tool', createToolHandler('ok')],
      ]);

      const handler = new ConversationHandler({
        provider,
        tools,
        logger,
        maxToolIterations: 2,
      });

      await handler.handleMessage(makeMessage());
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Max tool iterations')
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. Tool execution error handling
  // -------------------------------------------------------------------------
  describe('tool error handling', () => {
    it('should catch tool errors and return error as tool_result', async () => {
      const chatFn = vi.fn();
      chatFn.mockResolvedValueOnce(
        toolResponse('Running...', [{ id: 'tc-1', name: 'failing_tool', input: {} }])
      );
      chatFn.mockResolvedValueOnce(textResponse('The tool failed, sorry.'));

      const provider = createMockProvider(chatFn);
      const failingTool: ToolHandler = {
        description: 'A tool that fails',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };
      const tools = new Map<string, ToolHandler>([['failing_tool', failingTool]]);

      const handler = new ConversationHandler({ provider, tools, logger });
      const result = await handler.handleMessage(makeMessage());

      expect(result).toBe('The tool failed, sorry.');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Connection refused')
      );

      // Verify the error was passed as tool_result content
      const [secondCallMsgs] = chatFn.mock.calls[1];
      const toolResultMsg = secondCallMsgs[2];
      const resultBlocks = toolResultMsg.content as import('../../providers/types.js').ContentBlock[];
      expect(resultBlocks[0].content).toContain('Tool execution failed: Connection refused');
    });

    it('should handle unknown tool names gracefully', async () => {
      const chatFn = vi.fn();
      chatFn.mockResolvedValueOnce(
        toolResponse('', [{ id: 'tc-1', name: 'nonexistent_tool', input: {} }])
      );
      chatFn.mockResolvedValueOnce(textResponse('Tool not found.'));

      const provider = createMockProvider(chatFn);
      const tools = new Map<string, ToolHandler>();

      const handler = new ConversationHandler({ provider, tools, logger });
      const result = await handler.handleMessage(makeMessage());

      expect(result).toBe('Tool not found.');
      expect(logger.error).toHaveBeenCalledWith('Unknown tool: nonexistent_tool');

      // Verify error was sent as tool_result
      const [secondCallMsgs] = chatFn.mock.calls[1];
      const toolResultMsg = secondCallMsgs[2];
      const resultBlocks = toolResultMsg.content as import('../../providers/types.js').ContentBlock[];
      expect(resultBlocks[0].content).toContain('Unknown tool');
    });

    it('should handle non-Error thrown values', async () => {
      const chatFn = vi.fn();
      chatFn.mockResolvedValueOnce(
        toolResponse('', [{ id: 'tc-1', name: 'weird_tool', input: {} }])
      );
      chatFn.mockResolvedValueOnce(textResponse('handled'));

      const provider = createMockProvider(chatFn);
      const weirdTool: ToolHandler = {
        description: 'throws non-Error',
        inputSchema: { type: 'object', properties: {} },
        handler: vi.fn().mockRejectedValue('string error'),
      };
      const tools = new Map<string, ToolHandler>([['weird_tool', weirdTool]]);

      const handler = new ConversationHandler({ provider, tools, logger });
      await handler.handleMessage(makeMessage());

      const [secondCallMsgs] = chatFn.mock.calls[1];
      const toolResultMsg = secondCallMsgs[2];
      const resultBlocks = toolResultMsg.content as import('../../providers/types.js').ContentBlock[];
      expect(resultBlocks[0].content).toContain('string error');
    });
  });

  // -------------------------------------------------------------------------
  // 6. History management (trimming)
  // -------------------------------------------------------------------------
  describe('history management', () => {
    it('should trim history when it exceeds maxHistory', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('reply'));
      const provider = createMockProvider(chatFn);
      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
        maxHistory: 4,
      });

      // Send 3 messages -> 6 entries (3 user + 3 assistant)
      await handler.handleMessage(makeMessage({ content: 'msg 1' }));
      await handler.handleMessage(makeMessage({ content: 'msg 2' }));
      await handler.handleMessage(makeMessage({ content: 'msg 3' }));

      // On 3rd call, history before trim: [u1, a1, u2, a2, u3, a3] = 6 entries
      // Trimmed to 4 most recent: [u2, a2, u3, a3]
      // Now the 4th call: provider should receive these 4 + the new user msg = 5
      await handler.handleMessage(makeMessage({ content: 'msg 4' }));

      // The 4th provider call should have 5 messages
      // (4 from trimmed history + 1 new user message)
      const lastCallMessages = chatFn.mock.calls[3][0];
      expect(lastCallMessages).toHaveLength(5);
      expect(lastCallMessages[0].content).toBe('msg 2');
      expect(lastCallMessages[4].content).toBe('msg 4');
    });

    it('should not trim during tool loop, only at the end', async () => {
      const chatFn = vi.fn();
      // First call: tool call
      chatFn.mockResolvedValueOnce(
        toolResponse('thinking', [{ id: 'tc-1', name: 'tool_a', input: {} }])
      );
      // Second call: final text
      chatFn.mockResolvedValueOnce(textResponse('done'));

      const provider = createMockProvider(chatFn);
      const tools = new Map<string, ToolHandler>([
        ['tool_a', createToolHandler('result')],
      ]);

      const handler = new ConversationHandler({
        provider,
        tools,
        logger,
        maxHistory: 3,
      });

      await handler.handleMessage(makeMessage());

      // After: [user, assistant(tool_use), user(tool_result), assistant(final)] = 4 entries
      // maxHistory=3 → excess=1 → splice removes [user]
      // Remaining: [assistant(tool_use), user(tool_result), assistant(final)]
      // trimHistory cleanup: assistant(tool_use) removed (not user), user(tool_result) removed
      // (isToolResult=true), assistant(final) removed (not user) → history is empty

      // Send another message to verify history was cleaned
      chatFn.mockResolvedValueOnce(textResponse('next'));
      await handler.handleMessage(makeMessage({ content: 'next msg' }));

      // History was emptied after trim cleanup, so only the new user message is present
      const lastCallMessages = chatFn.mock.calls[2][0];
      expect(lastCallMessages).toHaveLength(1);
      expect(lastCallMessages[0].content).toBe('next msg');
    });

    it('should not orphan tool_result blocks after trimming', async () => {
      const chatFn = vi.fn();
      // Build up a history with a tool loop then plain messages
      // Message 1: plain user -> tool call -> tool result -> final
      chatFn.mockResolvedValueOnce(
        toolResponse('checking', [{ id: 'tc-1', name: 'tool_a', input: {} }])
      );
      chatFn.mockResolvedValueOnce(textResponse('result from tool'));
      // Message 2: plain text
      chatFn.mockResolvedValueOnce(textResponse('reply 2'));
      // Message 3: plain text
      chatFn.mockResolvedValueOnce(textResponse('reply 3'));

      const provider = createMockProvider(chatFn);
      const tools = new Map<string, ToolHandler>([
        ['tool_a', createToolHandler({ ok: true })],
      ]);

      const handler = new ConversationHandler({
        provider,
        tools,
        logger,
        maxHistory: 4, // tight limit to force trimming into tool loop
      });

      // Message 1: produces [u1, asst(tool_use), user(tool_result), asst(final)] = 4 entries
      await handler.handleMessage(makeMessage({ content: 'msg 1' }));
      // Message 2: 4 + [u2, a2] = 6, trim to 4 → [user(tool_result), asst(final), u2, a2]
      // cleanup removes user(tool_result) and asst(final) → [u2, a2]
      await handler.handleMessage(makeMessage({ content: 'msg 2' }));
      // Message 3: [u2, a2] + [u3, a3] = 4, no trim needed
      await handler.handleMessage(makeMessage({ content: 'msg 3' }));

      // 4th call (message 3): history should have [u2, a2, u3] = 3 messages
      const lastCallMessages = chatFn.mock.calls[3][0];
      // Should start with a plain user message, never a tool_result
      expect(lastCallMessages[0].role).toBe('user');
      expect(typeof lastCallMessages[0].content).toBe('string');
      expect(lastCallMessages[0].content).toBe('msg 2');
    });

    it('should ensure history starts with plain user message after trim', async () => {
      const chatFn = vi.fn();
      // Build history: tool loop produces assistant(tool_use) and user(tool_result)
      chatFn.mockResolvedValueOnce(
        toolResponse('', [{ id: 'tc-1', name: 'tool_a', input: {} }])
      );
      chatFn.mockResolvedValueOnce(textResponse('done'));
      // Second message
      chatFn.mockResolvedValueOnce(textResponse('reply'));

      const provider = createMockProvider(chatFn);
      const tools = new Map<string, ToolHandler>([
        ['tool_a', createToolHandler('ok')],
      ]);

      const handler = new ConversationHandler({
        provider,
        tools,
        logger,
        maxHistory: 2, // very tight: forces aggressive trimming
      });

      // History after msg 1: [u, asst(tool_use), user(tool_result), asst] = 4
      // Trim to 2 → [user(tool_result), asst] → cleanup removes both → empty
      await handler.handleMessage(makeMessage({ content: 'first' }));

      // Now history is empty; msg 2 gets only the new user message
      await handler.handleMessage(makeMessage({ content: 'second' }));
      const lastCallMessages = chatFn.mock.calls[2][0];
      expect(lastCallMessages).toHaveLength(1);
      expect(lastCallMessages[0]).toEqual({ role: 'user', content: 'second' });
    });

    it('should clearHistory for a specific chat', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('reply'));
      const provider = createMockProvider(chatFn);
      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
      });

      await handler.handleMessage(makeMessage({ channelId: 'chat-A', content: 'hello' }));
      handler.clearHistory('chat-A');

      // After clearing, next message should start fresh with only 1 message
      await handler.handleMessage(makeMessage({ channelId: 'chat-A', content: 'hi again' }));
      const messages = chatFn.mock.calls[1][0];
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('hi again');
    });
  });

  // -------------------------------------------------------------------------
  // 7. History isolation between different chatIds
  // -------------------------------------------------------------------------
  describe('chat isolation', () => {
    it('should maintain separate histories for different chatIds', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('ok'));
      const provider = createMockProvider(chatFn);
      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
      });

      await handler.handleMessage(makeMessage({ channelId: 'chat-A', content: 'Alice says hi' }));
      await handler.handleMessage(makeMessage({ channelId: 'chat-B', content: 'Bob says hi' }));
      await handler.handleMessage(makeMessage({ channelId: 'chat-A', content: 'Alice follows up' }));

      // Third call is chat-A's second message - should have 3 messages
      // (user1, assistant1, user2) but not Bob's messages
      const thirdCallMessages = chatFn.mock.calls[2][0];
      expect(thirdCallMessages).toHaveLength(3);
      expect(thirdCallMessages[0].content).toBe('Alice says hi');
      expect(thirdCallMessages[1].content).toBe('ok'); // assistant reply
      expect(thirdCallMessages[2].content).toBe('Alice follows up');
    });

    it('should not affect other chats when clearing one chat history', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('ok'));
      const provider = createMockProvider(chatFn);
      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
      });

      await handler.handleMessage(makeMessage({ channelId: 'chat-A', content: 'A1' }));
      await handler.handleMessage(makeMessage({ channelId: 'chat-B', content: 'B1' }));

      handler.clearHistory('chat-A');

      // chat-A should start fresh
      await handler.handleMessage(makeMessage({ channelId: 'chat-A', content: 'A2' }));
      const chatAMessages = chatFn.mock.calls[2][0];
      expect(chatAMessages).toHaveLength(1);
      expect(chatAMessages[0].content).toBe('A2');

      // chat-B should still have history
      await handler.handleMessage(makeMessage({ channelId: 'chat-B', content: 'B2' }));
      const chatBMessages = chatFn.mock.calls[3][0];
      expect(chatBMessages).toHaveLength(3);
      expect(chatBMessages[0].content).toBe('B1');
    });
  });

  // -------------------------------------------------------------------------
  // 8. Tool result truncation
  // -------------------------------------------------------------------------
  describe('tool result truncation', () => {
    it('should truncate very long tool results', async () => {
      const chatFn = vi.fn();
      chatFn.mockResolvedValueOnce(
        toolResponse('', [{ id: 'tc-1', name: 'big_tool', input: {} }])
      );
      chatFn.mockResolvedValueOnce(textResponse('done'));

      const provider = createMockProvider(chatFn);
      const longResult = 'x'.repeat(5000);
      const tools = new Map<string, ToolHandler>([
        ['big_tool', createToolHandler(longResult)],
      ]);

      const handler = new ConversationHandler({ provider, tools, logger });
      await handler.handleMessage(makeMessage());

      const [secondCallMsgs] = chatFn.mock.calls[1];
      const toolResultMsg = secondCallMsgs[2];
      const resultBlocks = toolResultMsg.content as import('../../providers/types.js').ContentBlock[];
      // JSON.stringify wraps in quotes: '"xxx..."' — the stringified result is > 4000
      expect(resultBlocks[0].content!.length).toBeLessThanOrEqual(4020); // 4000 + '... [truncated]'
      expect(resultBlocks[0].content).toContain('... [truncated]');
    });
  });

  // -------------------------------------------------------------------------
  // 9. CSM persistence
  // -------------------------------------------------------------------------
  describe('CSM persistence', () => {
    it('should load history from store on first message', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('hi'));
      const provider = createMockProvider(chatFn);
      const store = {
        load: vi.fn().mockReturnValue([
          { role: 'user' as const, content: 'previous' },
          { role: 'assistant' as const, content: 'prev reply' },
        ]),
        save: vi.fn(),
        clear: vi.fn(),
      };

      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
        store,
      });

      await handler.handleMessage(makeMessage({ content: 'new msg' }));

      expect(store.load).toHaveBeenCalledWith('chat-1');
      const [messages] = chatFn.mock.calls[0];
      expect(messages).toHaveLength(3); // 2 from store + 1 new
      expect(messages[0].content).toBe('previous');
    });

    it('should save history to store after response', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('reply'));
      const provider = createMockProvider(chatFn);
      const store = {
        load: vi.fn().mockReturnValue([]),
        save: vi.fn(),
        clear: vi.fn(),
      };

      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
        store,
      });

      await handler.handleMessage(makeMessage({ content: 'hello' }));

      expect(store.save).toHaveBeenCalledWith('chat-1', expect.any(Array));
      const savedHistory = store.save.mock.calls[0][1];
      expect(savedHistory).toHaveLength(2); // user + assistant
    });

    it('should clear store on clearHistory', async () => {
      const store = {
        load: vi.fn().mockReturnValue([]),
        save: vi.fn(),
        clear: vi.fn(),
      };

      const handler = new ConversationHandler({
        provider: createMockProvider(async () => textResponse('ok')),
        tools: new Map(),
        logger,
        store,
      });

      handler.clearHistory('chat-1');
      expect(store.clear).toHaveBeenCalledWith('chat-1');
    });
  });

  // -------------------------------------------------------------------------
  // 10. Typing callback
  // -------------------------------------------------------------------------
  describe('typing callback', () => {
    it('should call onTyping before LLM call', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('ok'));
      const provider = createMockProvider(chatFn);
      const onTyping = vi.fn();

      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
        onTyping,
      });

      await handler.handleMessage(makeMessage());

      expect(onTyping).toHaveBeenCalledWith('chat-1');
    });
  });
});
