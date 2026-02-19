// src/providers/router.ts
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamChunk } from './types.js';

export interface ProviderRouterConfig {
  primary: LLMProvider;
  fallback: LLMProvider[];
}

export class ProviderRouter implements LLMProvider {
  readonly name = 'router';
  private primary: LLMProvider;
  private fallback: LLMProvider[];

  constructor(config: ProviderRouterConfig) {
    this.primary = config.primary;
    this.fallback = config.fallback;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const providers = [this.primary, ...this.fallback];
    const errors: Error[] = [];

    for (const provider of providers) {
      try {
        return await provider.chat(messages, options);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    throw new Error(`All providers failed: ${errors.map(e => e.message).join('; ')}`);
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const providers = [this.primary, ...this.fallback];
    const errors: Error[] = [];

    for (const provider of providers) {
      try {
        yield* provider.stream(messages, options);
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    throw new Error(`All providers failed: ${errors.map(e => e.message).join('; ')}`);
  }

  async models(): Promise<string[]> {
    const allModels: string[] = [];
    for (const provider of [this.primary, ...this.fallback]) {
      try {
        const models = await provider.models();
        allModels.push(...models);
      } catch {
        // Skip unavailable providers
      }
    }
    return allModels;
  }

  async isAvailable(): Promise<boolean> {
    for (const provider of [this.primary, ...this.fallback]) {
      if (await provider.isAvailable()) return true;
    }
    return false;
  }

  listProviders(): string[] {
    return [this.primary.name, ...this.fallback.map(p => p.name)];
  }

  getProvider(name: string): LLMProvider | undefined {
    if (this.primary.name === name) return this.primary;
    return this.fallback.find(p => p.name === name);
  }
}
