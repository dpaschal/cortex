import { describe, it, expect, beforeEach } from 'vitest';
import { AuthManager, AuthConfig, AuthToken } from '../src/security/auth';
import { Logger } from 'winston';

// Create a mock logger for testing
const createMockLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger);

describe('AuthManager Token Tests', () => {
  let authManager: AuthManager;
  const testSecret = 'test-cluster-secret-for-testing';

  beforeEach(() => {
    const config: AuthConfig = {
      logger: createMockLogger(),
      certsDir: '/tmp/test-certs',
      clusterSecret: testSecret,
    };
    authManager = new AuthManager(config);
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
});
