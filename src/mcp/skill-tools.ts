// src/mcp/skill-tools.ts
import type { ToolHandler } from '../plugins/types.js';
import { SkillLoader } from '../skills/loader.js';

export interface SkillToolsConfig {
  directories: string[];
}

export async function createSkillTools(config: SkillToolsConfig): Promise<{ tools: Map<string, ToolHandler>; loader: SkillLoader }> {
  const loader = new SkillLoader(config.directories);
  await loader.loadAll();

  const tools = new Map<string, ToolHandler>();

  tools.set('list_skills', {
    description: 'List all loaded SKILL.md skills',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const skills = loader.listSkills();
      return {
        skills: skills.map(s => ({
          name: s.name, description: s.description,
          triggers: s.triggers, filePath: s.filePath,
        })),
        count: skills.length,
      };
    },
  });

  tools.set('get_skill', {
    description: 'Get a specific SKILL.md skill by name, including its full content',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill name' } },
      required: ['name'],
    },
    handler: async (args) => {
      const name = args.name as string;
      const skill = loader.getSkill(name);
      if (!skill) {
        return { error: `Skill not found: ${name}`, available: loader.listSkills().map(s => s.name) };
      }
      return { skill };
    },
  });

  return { tools, loader };
}
