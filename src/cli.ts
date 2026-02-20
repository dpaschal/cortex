#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import winston from 'winston';
import { GrpcClientPool, ClusterClient } from './grpc/client.js';

const logger = winston.createLogger({
  level: 'error',
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

function createClient(address: string): { pool: GrpcClientPool; client: ClusterClient } {
  const pool = new GrpcClientPool({ logger });
  const client = new ClusterClient(pool, address);
  return { pool, client };
}

function formatBytes(bytes: string | number): string {
  const b = typeof bytes === 'string' ? parseInt(bytes) : bytes;
  if (b === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function shortName(nodeId: string): string {
  // "forge-abc12345" → "forge", "terminus-mcp-xyz" → "terminus-mcp"
  const parts = nodeId.split('-');
  if (parts.length <= 1) return nodeId;
  // Last part is the UUID suffix — drop it
  return parts.slice(0, -1).join('-');
}

const program = new Command();

program
  .name('cortex-ctl')
  .description('Cortex cluster management CLI')
  .version('0.1.0');

// ── cortex-ctl nodes ──────────────────────────────────────
program
  .command('nodes')
  .description('List cluster nodes')
  .option('-a, --address <addr>', 'gRPC address to connect to', 'localhost:50051')
  .action(async (opts) => {
    const { pool, client } = createClient(opts.address);
    try {
      await pool.loadProto();
      const ready = await pool.waitForReady(opts.address, 5000);
      if (!ready) {
        console.error(chalk.red(`Cannot connect to ${opts.address}`));
        process.exit(1);
      }
      const state = await client.getClusterState();

      // Filter out MCP proxy nodes
      const nodes = state.nodes.filter((n: any) => !n.node_id.endsWith('-mcp'));

      console.log(chalk.bold(`\nCluster: ${state.cluster_id}  Term: ${state.term}\n`));

      // Pad raw text, then colorize
      const W = { name: 18, role: 12, status: 10, ip: 18, cpu: 8, mem: 12 };
      console.log(chalk.dim(
        'NAME'.padEnd(W.name) + 'ROLE'.padEnd(W.role) + 'STATUS'.padEnd(W.status) +
        'IP'.padEnd(W.ip) + 'CPU'.padEnd(W.cpu) + 'MEM'
      ));
      console.log(chalk.dim('─'.repeat(78)));

      for (const node of nodes) {
        const name = shortName(node.node_id);
        const isLeader = node.node_id === state.leader_id;
        const role = node.role?.replace('NODE_ROLE_', '').toLowerCase() ?? '?';
        const status = node.status?.replace('NODE_STATUS_', '').toLowerCase() ?? '?';
        const ip = node.tailscale_ip ?? '';
        const cpu = node.resources?.cpu_cores ? `${node.resources.cpu_cores}c` : '-';
        const mem = node.resources?.memory_bytes && node.resources.memory_bytes !== '0'
          ? formatBytes(node.resources.memory_bytes) : '-';

        const nameRaw = isLeader ? `* ${name}` : `  ${name}`;
        const cols = [
          nameRaw.padEnd(W.name),
          role.padEnd(W.role),
          status.padEnd(W.status),
          ip.padEnd(W.ip),
          cpu.padEnd(W.cpu),
          mem,
        ].join('');

        // Colorize the whole line
        if (isLeader) {
          console.log(chalk.green(cols));
        } else if (status !== 'active') {
          console.log(chalk.dim(cols));
        } else {
          console.log(cols);
        }
      }

      console.log();
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    } finally {
      pool.closeAll();
    }
  });

// ── cortex-ctl switch-leader ──────────────────────────────
program
  .command('switch-leader')
  .argument('[name]', 'Node to prefer as next leader (informational — Raft picks)')
  .description('Step down current leader, triggering a new election')
  .option('-a, --address <addr>', 'gRPC address to connect to', 'localhost:50051')
  .action(async (name: string | undefined, opts: any) => {
    const { pool, client } = createClient(opts.address);
    try {
      await pool.loadProto();
      const ready = await pool.waitForReady(opts.address, 5000);
      if (!ready) {
        console.error(chalk.red(`Cannot connect to ${opts.address}`));
        process.exit(1);
      }

      // Get cluster state to find leader
      const state = await client.getClusterState();
      const leaderNode = state.nodes.find((n: any) => n.node_id === state.leader_id);
      if (!leaderNode) {
        console.error(chalk.red('No leader found in cluster'));
        process.exit(1);
      }

      // If a name was given, verify it exists
      if (name) {
        const target = state.nodes.find((n: any) => shortName(n.node_id) === name || n.hostname === name);
        if (!target) {
          console.error(chalk.red(`Node "${name}" not found. Available: ${state.nodes.map((n: any) => shortName(n.node_id)).join(', ')}`));
          process.exit(1);
        }
        if (target.node_id === state.leader_id) {
          console.log(chalk.yellow(`${name} is already the leader.`));
          process.exit(0);
        }
      }

      const leaderName = shortName(leaderNode.node_id);
      const leaderAddr = `${leaderNode.tailscale_ip}:${leaderNode.grpc_port}`;

      // Connect to leader and call TransferLeadership
      console.log(`Current leader: ${chalk.green(leaderName)} (term ${state.term})`);
      console.log(`Requesting step-down...`);

      const leaderClient = createClient(leaderAddr);
      await leaderClient.pool.loadProto();
      const leaderReady = await leaderClient.pool.waitForReady(leaderAddr, 5000);
      if (!leaderReady) {
        console.error(chalk.red(`Cannot connect to leader at ${leaderAddr}`));
        process.exit(1);
      }

      // Call TransferLeadership via raw gRPC (not in ClusterClient convenience wrapper yet)
      const conn = leaderClient.pool.getConnection(leaderAddr);
      const response: any = await leaderClient.pool.call(
        conn.clusterClient,
        'TransferLeadership',
        { target_node_id: name ?? '' },
      );

      leaderClient.pool.closeAll();

      if (response.success) {
        console.log(chalk.green(`✓ ${response.message}`));
        if (name) {
          console.log(chalk.dim(`(Raft will hold a new election — ${name} may or may not win)`));
        }
      } else {
        console.error(chalk.red(`✗ ${response.message}`));
        process.exit(1);
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    } finally {
      pool.closeAll();
    }
  });

program.parse(process.argv);
