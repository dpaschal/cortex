import { Plugin } from './types.js';

export type PluginFactory = () => Promise<Plugin>;

export const BUILTIN_PLUGINS: Record<string, PluginFactory> = {
  'memory':           () => import('./memory/index.js').then(m => new m.MemoryPlugin()),
  'cluster-tools':    () => import('./cluster-tools/index.js').then(m => new m.ClusterToolsPlugin()),
  'task-engine':      () => import('./task-engine/index.js').then(m => new m.TaskEnginePlugin()),
  'kubernetes':       () => import('./kubernetes/index.js').then(m => new m.KubernetesPlugin()),
  'resource-monitor': () => import('./resource-monitor/index.js').then(m => new m.ResourceMonitorPlugin()),
  'updater':          () => import('./updater/index.js').then(m => new m.UpdaterPlugin()),
  'skills':           () => import('./skills/index.js').then(m => new m.SkillsPlugin()),
  'messaging':        () => import('./messaging/index.js').then(m => new m.MessagingPlugin()),
  'cluster-health':   () => import('./cluster-health/index.js').then(m => new m.ClusterHealthPlugin()),
};
