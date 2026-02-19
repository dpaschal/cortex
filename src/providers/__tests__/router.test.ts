// src/providers/__tests__/router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderRouter } from '../router.js';
import type { LLMProvider, ChatResponse } from '../types.js';

function createMockProvider(name: string, available: boolean, response?: string): LLMProvider {
  return {
    name,
    chat: available
      ? vi.fn().mockResolvedValue({
          content: response ?? `Hello from ${name}`,
          model: `${name}-model`,
          usage: { inputTokens: 10, outputTokens: 5 },
        } satisfies ChatResponse)
      : vi.fn().mockRejectedValue(new Error(`${name} unavailable`)),
    stream: vi.fn() as any,
    models: vi.fn().mockResolvedValue([`${name}-model`]),
    isAvailable: vi.fn().mockResolvedValue(available),
  };
}

describe('ProviderRouter', () => {
  it('should use the primary provider when available', async () => {
    const primary = createMockProvider('anthropic', true);
    const fallback = createMockProvider('openai', true);
    const router = new ProviderRouter({ primary, fallback: [fallback] });

    const response = await router.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toBe('Hello from anthropic');
    expect(primary.chat).toHaveBeenCalled();
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it('should fall back when primary fails', async () => {
    const primary = createMockProvider('anthropic', false);
    const fallback = createMockProvider('openai', true);
    const router = new ProviderRouter({ primary, fallback: [fallback] });

    const response = await router.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toBe('Hello from openai');
  });

  it('should cascade through multiple fallbacks', async () => {
    const primary = createMockProvider('anthropic', false);
    const fallback1 = createMockProvider('openai', false);
    const fallback2 = createMockProvider('ollama', true);
    const router = new ProviderRouter({ primary, fallback: [fallback1, fallback2] });

    const response = await router.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toBe('Hello from ollama');
  });

  it('should throw when all providers fail', async () => {
    const primary = createMockProvider('anthropic', false);
    const fallback = createMockProvider('openai', false);
    const router = new ProviderRouter({ primary, fallback: [fallback] });

    await expect(router.chat([{ role: 'user', content: 'Hello' }])).rejects.toThrow('All providers failed');
  });

  it('should list all available providers', () => {
    const primary = createMockProvider('anthropic', true);
    const fallback = createMockProvider('openai', true);
    const router = new ProviderRouter({ primary, fallback: [fallback] });

    expect(router.listProviders()).toEqual(['anthropic', 'openai']);
  });

  it('should get a specific provider by name', () => {
    const primary = createMockProvider('anthropic', true);
    const fallback = createMockProvider('openai', true);
    const router = new ProviderRouter({ primary, fallback: [fallback] });

    expect(router.getProvider('openai')?.name).toBe('openai');
    expect(router.getProvider('nonexistent')).toBeUndefined();
  });
});
