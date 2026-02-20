import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { parse as parseYaml } from 'yaml';

describe('Plugin Config', () => {
  it('default.yaml should have a plugins section with all 7 plugins', () => {
    const configFile = fs.readFileSync('config/default.yaml', 'utf-8');
    const config = parseYaml(configFile);

    expect(config.plugins).toBeDefined();
    expect(config.plugins.memory).toBeDefined();
    expect(config.plugins.memory.enabled).toBe(true);
    expect(config.plugins['cluster-tools']).toBeDefined();
    expect(config.plugins['resource-monitor']).toBeDefined();
    expect(config.plugins.updater).toBeDefined();
    expect(config.plugins.skills).toBeDefined();
    expect(config.plugins.messaging).toBeDefined();
    expect(config.plugins.kubernetes).toBeDefined();
  });

  it('kubernetes and skills should be disabled by default', () => {
    const configFile = fs.readFileSync('config/default.yaml', 'utf-8');
    const config = parseYaml(configFile);
    expect(config.plugins.kubernetes.enabled).toBe(false);
    expect(config.plugins.skills.enabled).toBe(false);
  });

  it('memory, cluster-tools, resource-monitor, updater, and messaging should be enabled by default', () => {
    const configFile = fs.readFileSync('config/default.yaml', 'utf-8');
    const config = parseYaml(configFile);
    expect(config.plugins.memory.enabled).toBe(true);
    expect(config.plugins['cluster-tools'].enabled).toBe(true);
    expect(config.plugins['resource-monitor'].enabled).toBe(true);
    expect(config.plugins.updater.enabled).toBe(true);
    expect(config.plugins.messaging.enabled).toBe(true);
  });
});
