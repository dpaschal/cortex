import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillsPlugin } from '../../src/plugins/skills/index.js';
import { PluginContext } from '../../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../../src/mcp/skill-tools.js', () => ({
  createSkillTools: vi.fn().mockResolvedValue({
    tools: new Map([
      ['list_skills', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
      ['get_skill', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ]),
    loader: { stop: vi.fn(), listSkills: vi.fn().mockReturnValue([]) },
  }),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: {} as any, membership: {} as any, scheduler: {} as any,
    stateManager: {} as any, clientPool: {} as any,
    sharedMemoryDb: {} as any, memoryReplicator: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node', sessionId: 'test-session',
    config: { enabled: true, directories: ['~/.cortex/skills'], ...config },
    events: new EventEmitter(),
  };
}

describe('SkillsPlugin', () => {
  let plugin: SkillsPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new SkillsPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('skills');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose skill tools', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools!();
    expect(tools.size).toBe(2);
    expect(tools.has('list_skills')).toBe(true);
    expect(tools.has('get_skill')).toBe(true);
  });

  it('should pass directories to createSkillTools', async () => {
    const { createSkillTools } = await import('../../src/mcp/skill-tools.js');
    await plugin.init(createMockContext({ directories: ['/custom/skills'] }));
    expect(createSkillTools).toHaveBeenCalledWith(
      expect.objectContaining({ directories: ['/custom/skills'] })
    );
  });

  it('should stop skill loader on stop', async () => {
    const { createSkillTools } = await import('../../src/mcp/skill-tools.js');
    await plugin.init(createMockContext());
    await plugin.stop();
    const mockResult = await (createSkillTools as any).mock.results[0].value;
    expect(mockResult.loader.stop).toHaveBeenCalled();
  });

  it('should start without error', async () => {
    await plugin.init(createMockContext());
    await plugin.start();
  });
});
