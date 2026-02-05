import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AuthManager, AuthConfig, AuthToken } from '../src/security/auth';
import { Logger } from 'winston';
import * as fs from 'fs/promises';

// Mock fs/promises module
vi.mock('fs/promises');

// Create a mock logger for testing
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger);

describe('AuthManager', () => {
  let authManager: AuthManager;
  const testSecret = 'test-cluster-secret-for-testing';
  const testCertsDir = '/tmp/test-certs';

  beforeEach(() => {
    vi.clearAllMocks();
    const config: AuthConfig = {
      logger: createMockLogger(),
      certsDir: testCertsDir,
      clusterSecret: testSecret,
    };
    authManager = new AuthManager(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Token Generation', () => {
    it('should generate valid join token with signature', () => {
      const nodeId = 'test-node-1';
      const tokenStr = authManager.generateJoinToken(nodeId);

      // Token should be a non-empty string
      expect(tokenStr).toBeDefined();
      expect(typeof tokenStr).toBe('string');
      expect(tokenStr.length).toBeGreaterThan(0);

      // Decode the token and verify structure
      const decoded = JSON.parse(Buffer.from(tokenStr, 'base64').toString()) as AuthToken;

      // Token should contain required fields
      expect(decoded.nodeId).toBe(nodeId);
      expect(decoded.issuedAt).toBeDefined();
      expect(typeof decoded.issuedAt).toBe('number');
      expect(decoded.expiresAt).toBeDefined();
      expect(typeof decoded.expiresAt).toBe('number');
      expect(decoded.signature).toBeDefined();
      expect(typeof decoded.signature).toBe('string');
      expect(decoded.signature.length).toBeGreaterThan(0);

      // Signature should be a hex string (HMAC-SHA256 produces 64 hex characters)
      expect(decoded.signature).toMatch(/^[a-f0-9]{64}$/);

      // expiresAt should be after issuedAt
      expect(decoded.expiresAt).toBeGreaterThan(decoded.issuedAt);
    });

    it('should generate token with custom validity period', () => {
      const nodeId = 'test-node-2';
      const validityMs = 60000; // 1 minute
      const tokenStr = authManager.generateJoinToken(nodeId, validityMs);

      const decoded = JSON.parse(Buffer.from(tokenStr, 'base64').toString()) as AuthToken;

      // Check that validity period is approximately correct (within 100ms tolerance)
      const actualValidity = decoded.expiresAt - decoded.issuedAt;
      expect(actualValidity).toBe(validityMs);
    });
  });

  describe('Token Validation', () => {
    it('should validate unexpired token successfully', () => {
      const nodeId = 'valid-node';
      const tokenStr = authManager.generateJoinToken(nodeId);

      const result = authManager.validateJoinToken(tokenStr);

      expect(result.valid).toBe(true);
      expect(result.nodeId).toBe(nodeId);
      expect(result.reason).toBeUndefined();
    });

    it('should reject expired token', () => {
      const nodeId = 'expired-node';
      // Generate token with 1ms validity (will expire immediately)
      const tokenStr = authManager.generateJoinToken(nodeId, 1);

      // Wait a small amount to ensure token expires
      const startTime = Date.now();
      while (Date.now() - startTime < 10) {
        // Busy wait to ensure token expires
      }

      const result = authManager.validateJoinToken(tokenStr);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Token expired');
      expect(result.nodeId).toBeUndefined();
    });

    it('should reject tampered token', () => {
      const nodeId = 'tampered-node';
      const tokenStr = authManager.generateJoinToken(nodeId);

      // Decode, tamper, and re-encode the token
      const decoded = JSON.parse(Buffer.from(tokenStr, 'base64').toString()) as AuthToken;

      // Tamper with the nodeId
      decoded.nodeId = 'malicious-node';

      // Re-encode without updating signature
      const tamperedTokenStr = Buffer.from(JSON.stringify(decoded)).toString('base64');

      const result = authManager.validateJoinToken(tamperedTokenStr);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });

    it('should reject token with tampered expiry', () => {
      const nodeId = 'expiry-tampered-node';
      const tokenStr = authManager.generateJoinToken(nodeId, 1000);

      // Decode and extend expiry without updating signature
      const decoded = JSON.parse(Buffer.from(tokenStr, 'base64').toString()) as AuthToken;
      decoded.expiresAt = Date.now() + 999999999; // Extend expiry

      const tamperedTokenStr = Buffer.from(JSON.stringify(decoded)).toString('base64');

      const result = authManager.validateJoinToken(tamperedTokenStr);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });

    it('should reject invalid base64 token', () => {
      const result = authManager.validateJoinToken('not-valid-base64!!!');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid token format');
    });

    it('should reject malformed JSON token', () => {
      const invalidJson = Buffer.from('{ invalid json }').toString('base64');

      const result = authManager.validateJoinToken(invalidJson);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid token format');
    });
  });

  describe('Token Isolation', () => {
    it('should not validate token from different AuthManager instance', () => {
      // Create two AuthManagers with different secrets
      const authManager1 = new AuthManager({
        logger: createMockLogger(),
        certsDir: '/tmp/test-certs-1',
        clusterSecret: 'secret-cluster-1',
      });

      const authManager2 = new AuthManager({
        logger: createMockLogger(),
        certsDir: '/tmp/test-certs-2',
        clusterSecret: 'secret-cluster-2',
      });

      const nodeId = 'cross-cluster-node';
      const tokenStr = authManager1.generateJoinToken(nodeId);

      // Token from authManager1 should not validate on authManager2
      const result = authManager2.validateJoinToken(tokenStr);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });
  });

  describe('Certificate Generation', () => {
    it('should generate CA certificate', async () => {
      // Mock fs operations for CA generation
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const result = await authManager.generateCA();

      // Verify cert and key are returned as Buffers
      expect(result.cert).toBeInstanceOf(Buffer);
      expect(result.key).toBeInstanceOf(Buffer);
      expect(result.cert.length).toBeGreaterThan(0);
      expect(result.key.length).toBeGreaterThan(0);

      // Verify directory was created
      expect(fs.mkdir).toHaveBeenCalledWith(
        `${testCertsDir}/ca`,
        { recursive: true }
      );

      // Verify files were written
      expect(fs.writeFile).toHaveBeenCalledWith(
        `${testCertsDir}/ca/ca.crt`,
        expect.any(Buffer)
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        `${testCertsDir}/ca/ca.key`,
        expect.any(Buffer),
        { mode: 0o600 }
      );
    });

    it('should generate node certificate', async () => {
      // Mock CA files exist
      const mockCaCert = Buffer.from('mock-ca-cert');
      const mockCaKey = Buffer.from('mock-ca-key');

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        const pathStr = path.toString();
        if (pathStr.endsWith('ca.crt')) return mockCaCert;
        if (pathStr.endsWith('ca.key')) return mockCaKey;
        throw new Error(`Unexpected path: ${pathStr}`);
      });
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const nodeId = 'test-node-1';
      const hostname = 'test-host';
      const ips = ['192.168.1.1', '10.0.0.1'];

      const result = await authManager.generateNodeCertificate(nodeId, hostname, ips);

      // Verify NodeCredentials structure
      expect(result.nodeId).toBe(nodeId);
      expect(result.certificate).toBeInstanceOf(Buffer);
      expect(result.privateKey).toBeInstanceOf(Buffer);
      expect(result.caCertificate).toEqual(mockCaCert);

      // Verify node directory was created
      expect(fs.mkdir).toHaveBeenCalledWith(
        `${testCertsDir}/nodes/${nodeId}`,
        { recursive: true }
      );

      // Verify node cert and key were written
      expect(fs.writeFile).toHaveBeenCalledWith(
        `${testCertsDir}/nodes/${nodeId}/node.crt`,
        expect.any(Buffer)
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        `${testCertsDir}/nodes/${nodeId}/node.key`,
        expect.any(Buffer),
        { mode: 0o600 }
      );
    });

    it('should load existing credentials from disk', async () => {
      const nodeId = 'existing-node';
      const mockCert = Buffer.from('mock-node-cert');
      const mockKey = Buffer.from('mock-node-key');
      const mockCaCert = Buffer.from('mock-ca-cert');

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        const pathStr = path.toString();
        if (pathStr.endsWith('node.crt')) return mockCert;
        if (pathStr.endsWith('node.key')) return mockKey;
        if (pathStr.endsWith('ca.crt')) return mockCaCert;
        throw new Error(`Unexpected path: ${pathStr}`);
      });

      const result = await authManager.loadNodeCredentials(nodeId);

      expect(result).not.toBeNull();
      expect(result!.nodeId).toBe(nodeId);
      expect(result!.certificate).toEqual(mockCert);
      expect(result!.privateKey).toEqual(mockKey);
      expect(result!.caCertificate).toEqual(mockCaCert);

      // Verify correct paths were read
      expect(fs.readFile).toHaveBeenCalledWith(`${testCertsDir}/nodes/${nodeId}/node.crt`);
      expect(fs.readFile).toHaveBeenCalledWith(`${testCertsDir}/nodes/${nodeId}/node.key`);
      expect(fs.readFile).toHaveBeenCalledWith(`${testCertsDir}/ca/ca.crt`);
    });

    it('should create credentials directory if missing', async () => {
      // This test verifies mkdir is called with recursive: true
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await authManager.generateCA();

      // Verify mkdir was called with recursive option to create nested directories
      expect(fs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('ca'),
        { recursive: true }
      );
    });
  });

  describe('Peer Verification', () => {
    it('should verify valid peer certificate', () => {
      // Create a certificate buffer that includes the expected nodeId
      const nodeId = 'verified-node';
      const certContent = JSON.stringify({
        type: 'END_ENTITY',
        cn: `node:${nodeId}:hostname`,
        notBefore: new Date().toISOString(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const cert = Buffer.from(certContent);

      // Verify without expectedNodeId
      const resultWithoutExpected = authManager.verifyPeerCertificate(cert);
      expect(resultWithoutExpected).toBe(true);

      // Verify with matching expectedNodeId
      const resultWithExpected = authManager.verifyPeerCertificate(cert, nodeId);
      expect(resultWithExpected).toBe(true);
    });

    it('should reject certificate with wrong nodeId', () => {
      // Create a certificate with one nodeId
      const actualNodeId = 'actual-node';
      const certContent = JSON.stringify({
        type: 'END_ENTITY',
        cn: `node:${actualNodeId}:hostname`,
        notBefore: new Date().toISOString(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const cert = Buffer.from(certContent);

      // Try to verify with a different expectedNodeId
      const wrongNodeId = 'wrong-node';
      const result = authManager.verifyPeerCertificate(cert, wrongNodeId);

      expect(result).toBe(false);
    });
  });
});
