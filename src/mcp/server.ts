import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from 'winston';
import { ClusterStateManager, ClaudeSession, ContextEntry } from '../cluster/state.js';
import { MembershipManager } from '../cluster/membership.js';
import { TaskScheduler, TaskSpec, TaskStatus } from '../cluster/scheduler.js';
import { KubernetesAdapter, K8sJobSpec } from '../kubernetes/adapter.js';
import { GrpcClientPool } from '../grpc/client.js';
import { RaftNode } from '../cluster/raft.js';
import { createTools, ToolHandler } from './tools.js';
import { SharedMemoryDB } from '../memory/shared-memory-db.js';
import { MemoryReplicator } from '../memory/replication.js';
import { createMemoryTools } from '../memory/memory-tools.js';

export interface McpServerConfig {
  logger: Logger;
  stateManager: ClusterStateManager;
  membership: MembershipManager;
  scheduler: TaskScheduler;
  k8sAdapter: KubernetesAdapter;
  clientPool: GrpcClientPool;
  raft: RaftNode;
  sessionId: string;
  nodeId: string;
  sharedMemoryDb?: SharedMemoryDB;
  memoryReplicator?: MemoryReplicator;
}

export class ClusterMcpServer {
  private config: McpServerConfig;
  private server: Server;
  private toolHandlers: Map<string, ToolHandler>;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.server = new Server(
      {
        name: 'cortex',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.toolHandlers = this.createToolHandlers();
    this.setupHandlers();
  }

  private createToolHandlers(): Map<string, ToolHandler> {
    const clusterTools = createTools({
      stateManager: this.config.stateManager,
      membership: this.config.membership,
      scheduler: this.config.scheduler,
      k8sAdapter: this.config.k8sAdapter,
      clientPool: this.config.clientPool,
      raft: this.config.raft,
      sessionId: this.config.sessionId,
      nodeId: this.config.nodeId,
      logger: this.config.logger,
    });

    // Add shared memory tools
    if (this.config.sharedMemoryDb && this.config.memoryReplicator) {
      const memoryTools = createMemoryTools({
        db: this.config.sharedMemoryDb,
        replicator: this.config.memoryReplicator,
        raft: this.config.raft,
        logger: this.config.logger,
        nodeId: this.config.nodeId,
      });

      for (const [name, handler] of memoryTools) {
        clusterTools.set(name, handler);
      }

      this.config.logger.info('Memory tools registered', { count: memoryTools.size });
    }

    return clusterTools;
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.toolHandlers.entries()).map(([name, handler]) => ({
        name,
        description: handler.description,
        inputSchema: handler.inputSchema,
      }));

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const handler = this.toolHandlers.get(name);

      if (!handler) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      try {
        this.config.logger.debug('Executing MCP tool', { name, args });
        const result = await handler.handler(args ?? {});

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        this.config.logger.error('Tool execution failed', { name, error });
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    });

    // List resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = [
        {
          uri: 'cluster://state',
          name: 'Cluster State',
          description: 'Current state of the Claude Cluster',
          mimeType: 'application/json',
        },
        {
          uri: 'cluster://nodes',
          name: 'Cluster Nodes',
          description: 'List of all nodes in the cluster',
          mimeType: 'application/json',
        },
        {
          uri: 'cluster://sessions',
          name: 'Claude Sessions',
          description: 'Active Claude sessions in the cluster',
          mimeType: 'application/json',
        },
        {
          uri: 'cluster://k8s',
          name: 'Kubernetes Clusters',
          description: 'Available Kubernetes clusters',
          mimeType: 'application/json',
        },
      ];

      return { resources };
    });

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      let content: unknown;

      switch (uri) {
        case 'cluster://state':
          content = this.config.stateManager.getState();
          break;

        case 'cluster://nodes':
          content = this.config.membership.getAllNodes();
          break;

        case 'cluster://sessions':
          content = this.config.stateManager.getSessions();
          break;

        case 'cluster://k8s':
          content = this.config.k8sAdapter.listClusters();
          break;

        default:
          return {
            contents: [{
              uri,
              mimeType: 'text/plain',
              text: `Unknown resource: ${uri}`,
            }],
          };
      }

      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(content, null, 2),
        }],
      };
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.config.logger.info('MCP server started');
  }

  async stop(): Promise<void> {
    await this.server.close();
    this.config.logger.info('MCP server stopped');
  }
}
