import { Plugin, PluginContext, ToolHandler, ResourceHandler } from '../types.js';

export class KubernetesPlugin implements Plugin {
  name = 'kubernetes';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private resources: Map<string, ResourceHandler> = new Map();
  private adapter: any = null;

  async init(ctx: PluginContext): Promise<void> {
    const { KubernetesAdapter } = await import('../../kubernetes/adapter.js');
    this.adapter = new KubernetesAdapter({
      logger: ctx.logger,
      kubeconfigPath: ctx.config.kubeconfigPath as string | undefined,
    });

    await this.adapter.discoverClusters();

    // k8s_list_clusters
    this.tools.set('k8s_list_clusters', {
      description: 'List all available Kubernetes clusters (GKE, K8s, K3s)',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const clusters = this.adapter.listClusters();
        return clusters.map((c: any) => ({
          name: c.name,
          type: c.type,
          context: c.context,
          nodes: c.nodes.length,
          totalCpu: c.totalCpu,
          totalMemoryGb: (c.totalMemory / (1024 ** 3)).toFixed(1),
          gpuNodes: c.gpuNodes,
        }));
      },
    });

    // k8s_submit_job
    this.tools.set('k8s_submit_job', {
      description: 'Submit a job to a Kubernetes cluster',
      inputSchema: {
        type: 'object',
        properties: {
          cluster: { type: 'string', description: 'Kubernetes cluster context name' },
          image: { type: 'string', description: 'Container image to run' },
          command: { type: 'array', items: { type: 'string' }, description: 'Command to run' },
          namespace: { type: 'string', description: 'Kubernetes namespace (default: default)' },
          cpuLimit: { type: 'string', description: 'CPU limit (e.g., "2", "500m")' },
          memoryLimit: { type: 'string', description: 'Memory limit (e.g., "4Gi", "512Mi")' },
          gpuLimit: { type: 'number', description: 'Number of GPUs to request' },
        },
        required: ['cluster', 'image'],
      },
      handler: async (args) => {
        const jobName = `cortex-${Date.now()}`;

        const spec = {
          name: jobName,
          namespace: args.namespace as string | undefined,
          image: args.image as string,
          command: args.command as string[] | undefined,
          cpuLimit: args.cpuLimit as string | undefined,
          memoryLimit: args.memoryLimit as string | undefined,
          gpuLimit: args.gpuLimit as number | undefined,
        };

        const name = await this.adapter.submitJob(args.cluster as string, spec);
        return {
          jobName: name,
          cluster: args.cluster,
          namespace: args.namespace ?? 'default',
        };
      },
    });

    // k8s_get_resources
    this.tools.set('k8s_get_resources', {
      description: 'Get resource information for a Kubernetes cluster',
      inputSchema: {
        type: 'object',
        properties: {
          cluster: { type: 'string', description: 'Kubernetes cluster context name' },
        },
        required: ['cluster'],
      },
      handler: async (args) => {
        const resources = await this.adapter.getClusterResources(args.cluster as string);
        if (!resources) {
          return { error: 'Cluster not found or inaccessible' };
        }
        return {
          totalCpu: resources.totalCpu,
          totalMemoryGb: (resources.totalMemory / (1024 ** 3)).toFixed(1),
          allocatableCpu: resources.allocatableCpu,
          allocatableMemoryGb: (resources.allocatableMemory / (1024 ** 3)).toFixed(1),
          gpuCount: resources.gpuCount,
          runningPods: resources.runningPods,
        };
      },
    });

    // k8s_scale
    this.tools.set('k8s_scale', {
      description: 'Scale a Kubernetes deployment',
      inputSchema: {
        type: 'object',
        properties: {
          cluster: { type: 'string', description: 'Kubernetes cluster context name' },
          deployment: { type: 'string', description: 'Deployment name' },
          replicas: { type: 'number', description: 'Desired number of replicas' },
          namespace: { type: 'string', description: 'Kubernetes namespace (default: default)' },
        },
        required: ['cluster', 'deployment', 'replicas'],
      },
      handler: async (args) => {
        const success = await this.adapter.scaleDeployment(
          args.cluster as string,
          args.deployment as string,
          args.replicas as number,
          args.namespace as string,
        );
        return { success, deployment: args.deployment, replicas: args.replicas };
      },
    });

    // Resource: cluster://k8s
    this.resources.set('cluster://k8s', {
      uri: 'cluster://k8s',
      name: 'Kubernetes Clusters',
      description: 'Discovered Kubernetes clusters and their resources',
      mimeType: 'application/json',
      handler: async () => this.adapter.listClusters(),
    });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): Map<string, ToolHandler> { return this.tools; }
  getResources(): Map<string, ResourceHandler> { return this.resources; }
}
