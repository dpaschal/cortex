// src/mcp/__tests__/skill-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSkillTools } from '../skill-tools.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('skill MCP tools', () => {
  let tmpDir: string;
  let tools: Map<string, any>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-tools-test-'));
    await fs.writeFile(path.join(tmpDir, 'greet.md'), `---\nname: greet\ndescription: Greet the user\ntriggers:\n  - hello\n  - hi\n---\nRespond with a friendly greeting.`);
    const result = await createSkillTools({ directories: [tmpDir] });
    tools = result.tools;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should register list_skills and get_skill tools', () => {
    expect(tools.has('list_skills')).toBe(true);
    expect(tools.has('get_skill')).toBe(true);
  });

  it('list_skills should return loaded skills', async () => {
    const handler = tools.get('list_skills')!;
    const result = await handler.handler({});
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe('greet');
  });

  it('get_skill should return skill content', async () => {
    const handler = tools.get('get_skill')!;
    const result = await handler.handler({ name: 'greet' });
    expect(result.skill.content).toContain('friendly greeting');
  });

  it('get_skill should return error for unknown skill', async () => {
    const handler = tools.get('get_skill')!;
    const result = await handler.handler({ name: 'nonexistent' });
    expect(result.error).toBeDefined();
  });
});
