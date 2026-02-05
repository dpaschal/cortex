import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RaftNode, RaftConfig, RaftState, LogEntryType } from '../src/cluster/raft.js';
import { GrpcClientPool } from '../src/grpc/client.js';
import { Logger } from 'winston';

// Mock the gRPC client module
vi.mock('../src/grpc/client.js', () => ({
  RaftClient: vi.fn().mockImplementation(() => ({
    requestVote: vi.fn(),
    appendEntries: vi.fn(),
  })),
  GrpcClientPool: vi.fn(),
}));

// Mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);

// Mock client pool
const createMockClientPool = (): GrpcClientPool => ({
  getConnection: vi.fn(),
} as unknown as GrpcClientPool);

// Helper to create test node
function createTestNode(overrides?: Partial<RaftConfig>): RaftNode {
  return new RaftNode({
    nodeId: 'node-1',
    logger: createMockLogger(),
    clientPool: createMockClientPool(),
    electionTimeoutMinMs: 150,
    electionTimeoutMaxMs: 300,
    heartbeatIntervalMs: 50,
    ...overrides,
  });
}

describe('RaftNode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should start in follower state', () => {
      const node = createTestNode();
      node.start();

      expect(node.getState()).toBe('follower');

      node.stop();
    });

    it('should start with term 0', () => {
      const node = createTestNode();
      node.start();

      expect(node.getCurrentTerm()).toBe(0);

      node.stop();
    });

    it('should have no leader initially', () => {
      const node = createTestNode();
      node.start();

      expect(node.getLeaderId()).toBeNull();

      node.stop();
    });

    it('should not be leader initially', () => {
      const node = createTestNode();
      node.start();

      expect(node.isLeader()).toBe(false);

      node.stop();
    });

    it('should have empty log initially', () => {
      const node = createTestNode();
      node.start();

      expect(node.getLastLogIndex()).toBe(0);
      expect(node.getLastLogTerm()).toBe(0);

      node.stop();
    });
  });
});
