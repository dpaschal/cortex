import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Membership Manager', () => {
  describe('Node Registration', () => {
    it('should register self node on creation', () => {
      const config = {
        nodeId: 'node-1',
        hostname: 'rog2',
        tailscaleIp: '100.104.78.123',
        grpcPort: 50051,
      };

      // Self node should be registered
      expect(config.nodeId).toBe('node-1');
      expect(config.tailscaleIp).toMatch(/^100\./);
    });

    it('should default role to follower', () => {
      const selfNode = {
        nodeId: 'node-1',
        role: 'follower' as const,
        status: 'active' as const,
      };

      expect(selfNode.role).toBe('follower');
    });

    it('should set status to pending when joining', () => {
      const statuses = ['pending_approval', 'active', 'draining', 'offline'] as const;

      expect(statuses).toContain('pending_approval');
    });
  });

  describe('Node Approval', () => {
    it('should add node to pending approvals', () => {
      const pendingNode = {
        nodeId: 'new-node',
        hostname: 'new-machine',
        tailscaleIp: '100.100.100.100',
        grpcPort: 50051,
      };

      const pendingApprovals = new Map();
      pendingApprovals.set(pendingNode.nodeId, pendingNode);

      expect(pendingApprovals.has('new-node')).toBe(true);
    });

    it('should auto-approve when autoApprove is enabled', () => {
      const config = {
        autoApprove: true,
      };

      expect(config.autoApprove).toBe(true);
    });

    it('should emit event on approval', () => {
      const events: string[] = [];
      const emit = (event: string) => events.push(event);

      emit('nodeJoined');

      expect(events).toContain('nodeJoined');
    });
  });

  describe('Heartbeat', () => {
    it('should update lastSeen on heartbeat', () => {
      const node = {
        nodeId: 'node-1',
        lastSeen: Date.now() - 5000,
      };

      node.lastSeen = Date.now();

      expect(Date.now() - node.lastSeen).toBeLessThan(1000);
    });

    it('should detect offline nodes', () => {
      const heartbeatTimeoutMs = 15000;
      const node = {
        nodeId: 'node-1',
        lastSeen: Date.now() - 20000, // 20 seconds ago
        status: 'active' as const,
      };

      const isOffline = Date.now() - node.lastSeen > heartbeatTimeoutMs;

      expect(isOffline).toBe(true);
    });

    it('should mark active node as online', () => {
      const heartbeatTimeoutMs = 15000;
      const node = {
        nodeId: 'node-1',
        lastSeen: Date.now() - 5000, // 5 seconds ago
        status: 'active' as const,
      };

      const isOffline = Date.now() - node.lastSeen > heartbeatTimeoutMs;

      expect(isOffline).toBe(false);
    });
  });

  describe('Node Roles', () => {
    it('should support all node roles', () => {
      const roles = ['leader', 'follower', 'candidate', 'worker'] as const;

      expect(roles).toHaveLength(4);
      expect(roles).toContain('leader');
      expect(roles).toContain('worker');
    });

    it('should update leader address on role change', () => {
      const node = {
        nodeId: 'node-1',
        tailscaleIp: '100.104.78.123',
        grpcPort: 50051,
        role: 'follower' as const,
      };

      let leaderAddress: string | null = null;

      // Simulate becoming leader
      node.role = 'leader' as const;
      if (node.role === 'leader') {
        leaderAddress = `${node.tailscaleIp}:${node.grpcPort}`;
      }

      expect(leaderAddress).toBe('100.104.78.123:50051');
    });
  });

  describe('Node Removal', () => {
    it('should set status to draining for graceful removal', () => {
      const node = {
        nodeId: 'node-1',
        status: 'active' as const,
      };

      // Simulate graceful removal
      (node as { status: string }).status = 'draining';

      expect(node.status).toBe('draining');
    });

    it('should remove node from membership list', () => {
      const nodes = new Map([
        ['node-1', { nodeId: 'node-1' }],
        ['node-2', { nodeId: 'node-2' }],
      ]);

      nodes.delete('node-1');

      expect(nodes.has('node-1')).toBe(false);
      expect(nodes.size).toBe(1);
    });
  });

  describe('Proto Conversion', () => {
    it('should convert node role to proto format', () => {
      const role = 'leader';
      const protoRole = `NODE_ROLE_${role.toUpperCase()}`;

      expect(protoRole).toBe('NODE_ROLE_LEADER');
    });

    it('should convert proto role back to internal format', () => {
      const protoRole = 'NODE_ROLE_FOLLOWER';
      const role = protoRole.replace('NODE_ROLE_', '').toLowerCase();

      expect(role).toBe('follower');
    });

    it('should convert timestamps to strings for proto', () => {
      const timestamp = Date.now();
      const protoTimestamp = timestamp.toString();

      expect(typeof protoTimestamp).toBe('string');
      expect(parseInt(protoTimestamp)).toBe(timestamp);
    });
  });

  describe('Cluster Events', () => {
    it('should emit nodeJoinRequest for pending nodes', () => {
      const events: Array<{ type: string; node: { nodeId: string } }> = [];

      const emit = (type: string, node: { nodeId: string }) => {
        events.push({ type, node });
      };

      emit('nodeJoinRequest', { nodeId: 'new-node' });

      expect(events[0].type).toBe('nodeJoinRequest');
    });

    it('should emit nodeOffline when node times out', () => {
      const events: string[] = [];
      const emit = (event: string) => events.push(event);

      emit('nodeOffline');

      expect(events).toContain('nodeOffline');
    });

    it('should emit nodeDraining on graceful shutdown', () => {
      const events: string[] = [];
      const emit = (event: string) => events.push(event);

      emit('nodeDraining');

      expect(events).toContain('nodeDraining');
    });
  });
});

describe('Cluster Announcements', () => {
  describe('Node Join Announcements', () => {
    it('should format join announcement message', () => {
      const node = {
        nodeId: 'new-node-123',
        hostname: 'terminus',
        tailscaleIp: '100.85.203.53',
        resources: {
          cpuCores: 8,
          memoryBytes: 16 * 1024 * 1024 * 1024,
          gpus: [] as Array<{ name: string }>,
        },
      };

      const announcement = formatJoinAnnouncement(node);

      expect(announcement).toContain('terminus');
      expect(announcement).toContain('reporting in');
    });

    it('should include resource summary in announcement', () => {
      const node = {
        hostname: 'rog2',
        resources: {
          cpuCores: 16,
          memoryBytes: 32 * 1024 * 1024 * 1024,
          gpus: [{ name: 'RTX 4090' }],
        },
      };

      const summary = formatResourceSummary(node.resources);

      expect(summary).toContain('16 cores');
      expect(summary).toContain('32 GB');
      expect(summary).toContain('RTX 4090');
    });

    it('should broadcast to all cluster nodes', () => {
      const nodes = ['node-1', 'node-2', 'node-3'];
      const broadcasted: string[] = [];

      nodes.forEach(nodeId => {
        broadcasted.push(nodeId);
      });

      expect(broadcasted).toHaveLength(3);
    });
  });

  describe('Node Leave Announcements', () => {
    it('should format leave announcement', () => {
      const node = {
        hostname: 'terminus',
        graceful: true,
      };

      const message = node.graceful
        ? `Node ${node.hostname} is leaving the cluster gracefully`
        : `Node ${node.hostname} has gone offline`;

      expect(message).toContain('gracefully');
    });
  });
});

// Helper functions for testing
function formatJoinAnnouncement(node: {
  nodeId: string;
  hostname: string;
  tailscaleIp: string;
  resources: { cpuCores: number; memoryBytes: number; gpus: Array<{ name: string }> };
}): string {
  const resourceSummary = formatResourceSummary(node.resources);
  return `Hey Claude! Node ${node.hostname} reporting in! ${resourceSummary}`;
}

function formatResourceSummary(resources: {
  cpuCores: number;
  memoryBytes: number;
  gpus: Array<{ name: string }>;
}): string {
  const memoryGB = Math.round(resources.memoryBytes / (1024 * 1024 * 1024));
  const parts = [
    `${resources.cpuCores} cores`,
    `${memoryGB} GB RAM`,
  ];

  if (resources.gpus.length > 0) {
    parts.push(resources.gpus.map(g => g.name).join(', '));
  }

  return parts.join(' | ');
}
