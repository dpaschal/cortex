import { Plugin, PluginContext, ToolHandler, ResourceHandler } from '../types.js';
import { createTools } from '../../mcp/tools.js';

export class ClusterToolsPlugin implements Plugin {
  name = 'cluster-tools';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private resources: Map<string, ResourceHandler> = new Map();

  async init(ctx: PluginContext): Promise<void> {
    // Pass a noop k8s adapter — real k8s tools come from the kubernetes plugin
    const noopK8s = {
      listClusters: () => [],
      submitJob: async () => '',
      getClusterResources: async () => null,
      scaleDeployment: async () => false,
      discoverClusters: async () => [],
    } as any;

    const allTools = createTools({
      stateManager: ctx.stateManager,
      membership: ctx.membership,
      scheduler: ctx.scheduler,
      k8sAdapter: noopK8s,
      clientPool: ctx.clientPool,
      raft: ctx.raft,
      sessionId: ctx.sessionId,
      nodeId: ctx.nodeId,
      logger: ctx.logger,
    });

    const excludeTools = [
      'k8s_list_clusters', 'k8s_submit_job', 'k8s_get_resources', 'k8s_scale',
      'initiate_rolling_update',
      // Task tools moved to task-engine plugin
      'submit_task', 'get_task_result', 'run_distributed', 'dispatch_subagents',
    ];
    for (const [name, handler] of allTools) {
      if (!excludeTools.includes(name)) {
        this.tools.set(name, handler);
      }
    }

    this.resources.set('cluster://state', {
      uri: 'cluster://state',
      name: 'Cluster State',
      description: 'Current state of the Cortex cluster',
      mimeType: 'application/json',
      handler: async () => ctx.stateManager.getState(),
    });
    this.resources.set('cluster://nodes', {
      uri: 'cluster://nodes',
      name: 'Cluster Nodes',
      description: 'List of all nodes in the cluster',
      mimeType: 'application/json',
      handler: async () => ctx.membership.getAllNodes(),
    });
    this.resources.set('cluster://sessions', {
      uri: 'cluster://sessions',
      name: 'Claude Sessions',
      description: 'Active Claude sessions in the cluster',
      mimeType: 'application/json',
      handler: async () => ctx.stateManager.getSessions(),
    });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): Map<string, ToolHandler> { return this.tools; }
  getResources(): Map<string, ResourceHandler> { return this.resources; }
}
