import { describe, it, expect } from 'vitest';
import { BUILTIN_PLUGINS } from '../../src/plugins/registry.js';

describe('Plugin Registry', () => {
  it('should export BUILTIN_PLUGINS with all 7 plugin names', () => {
    expect(Object.keys(BUILTIN_PLUGINS)).toEqual(
      expect.arrayContaining([
        'memory',
        'cluster-tools',
        'kubernetes',
        'resource-monitor',
        'updater',
        'skills',
        'messaging',
      ])
    );
    expect(Object.keys(BUILTIN_PLUGINS).length).toBe(7);
  });

  it('each entry should be a factory function', () => {
    for (const [name, factory] of Object.entries(BUILTIN_PLUGINS)) {
      expect(typeof factory).toBe('function');
    }
  });
});
