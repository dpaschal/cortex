import { describe, it, expect } from 'vitest';
import { DEFAULT_RETRY_POLICY, DEFAULT_SCHEDULER_WEIGHTS } from '../../../src/plugins/task-engine/types.js';

describe('Task Engine Types', () => {
  it('has sensible default retry policy', () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_POLICY.backoffMs).toBe(1000);
    expect(DEFAULT_RETRY_POLICY.backoffMultiplier).toBe(2);
    expect(DEFAULT_RETRY_POLICY.retryable).toBe(true);
  });

  it('has scheduler weights summing to ~1.0', () => {
    const w = DEFAULT_SCHEDULER_WEIGHTS;
    const sum = w.cpuHeadroom + w.memoryHeadroom + w.diskIoHeadroom + w.networkHeadroom + w.gpuHeadroom;
    expect(sum).toBe(1.0);
  });
});
