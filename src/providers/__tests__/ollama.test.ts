// src/providers/__tests__/ollama.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from '../ollama.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
  });

  it('should have the correct name', () => {
    expect(provider.name).toBe('ollama');
  });

  it('should call the Ollama API for chat', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: 'Hello from Llama' },
        model: 'llama3',
        eval_count: 20,
        prompt_eval_count: 10,
      }),
    });

    const response = await provider.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toBe('Hello from Llama');
    expect(response.model).toBe('llama3');
  });

  it('should list available models', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3' }, { name: 'mistral' }] }),
    });

    const models = await provider.models();
    expect(models).toEqual(['llama3', 'mistral']);
  });

  it('should check availability by pinging the API', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    expect(await provider.isAvailable()).toBe(true);
  });

  it('should report unavailable when API is down', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    expect(await provider.isAvailable()).toBe(false);
  });
});
