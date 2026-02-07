import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NetworkDB } from '../src/mcp/network-db.js';

// Mock pg module
vi.mock('pg', () => {
  const mockQuery = vi.fn();
  const mockEnd = vi.fn();
  return {
    default: {
      Pool: vi.fn(() => ({
        query: mockQuery,
        end: mockEnd,
      })),
    },
    __mockQuery: mockQuery,
    __mockEnd: mockEnd,
  };
});

// Access mocks
async function getMocks() {
  const pgModule = await import('pg') as any;
  return {
    mockQuery: pgModule.__mockQuery as ReturnType<typeof vi.fn>,
    mockEnd: pgModule.__mockEnd as ReturnType<typeof vi.fn>,
  };
}

describe('NetworkDB', () => {
  let db: NetworkDB;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mocks = await getMocks();
    mockQuery = mocks.mockQuery;
    mockQuery.mockReset();
    mocks.mockEnd.mockReset();
    db = new NetworkDB();
  });

  describe('lookupDevice', () => {
    it('finds a device by hostname (case-insensitive)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 4, hostname: 'terminus', ip_address: '192.168.1.16',
          mac_address: '00:00:00:00:00:03', device_type: 'workstation',
          connection_type: null, network: 'Main LAN', vlan_id: 1,
          status: 'active', last_seen: new Date('2026-02-06'),
        }],
      });

      const result = await db.lookupDevice('Terminus');
      expect(result).toHaveLength(1);
      expect(result[0].hostname).toBe('terminus');
      expect(result[0].ip_address).toBe('192.168.1.16');
      expect(mockQuery.mock.calls[0][1]).toEqual(['%terminus%']);
    });

    it('returns empty array when no match', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await db.lookupDevice('nonexistent');
      expect(result).toHaveLength(0);
    });
  });

  describe('listDevices', () => {
    it('returns all devices when no filter', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, hostname: 'anvil', ip_address: '192.168.1.138', network: 'Main LAN' },
          { id: 2, hostname: 'forge', ip_address: '10.0.10.11', network: '10GbE Infrastructure' },
        ],
      });

      const result = await db.listDevices();
      expect(result).toHaveLength(2);
    });

    it('filters by network', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, hostname: 'anvil', ip_address: '192.168.1.138', network: 'Main LAN' }],
      });

      const result = await db.listDevices({ network: 'Main LAN' });
      expect(result).toHaveLength(1);
      expect(mockQuery.mock.calls[0][1]).toEqual(['Main LAN']);
    });

    it('filters by device_type', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, hostname: 'anvil', device_type: 'server' }],
      });

      const result = await db.listDevices({ device_type: 'server' });
      expect(result).toHaveLength(1);
    });
  });

  describe('listNetworks', () => {
    it('returns all networks', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, network_id: 'vlan1', name: 'Main LAN', subnet: '192.168.1.0/24', vlan_id: 1 },
          { id: 2, network_id: 'vlan2', name: 'Home WiFi', subnet: '192.168.2.0/24', vlan_id: 2 },
        ],
      });

      const result = await db.listNetworks();
      expect(result).toHaveLength(2);
    });
  });

  describe('addDevice', () => {
    it('inserts a new device and returns it', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 10, hostname: 'newbox', ip_address: '192.168.1.50',
          mac_address: 'aa:bb:cc:dd:ee:ff', device_type: 'server',
          network: 'Main LAN', vlan_id: 1, status: 'online',
        }],
      });

      const result = await db.addDevice({
        hostname: 'newbox',
        ip_address: '192.168.1.50',
        mac_address: 'aa:bb:cc:dd:ee:ff',
        device_type: 'server',
        network: 'Main LAN',
        vlan_id: 1,
      });

      expect(result.hostname).toBe('newbox');
      expect(result.ip_address).toBe('192.168.1.50');
    });
  });

  describe('updateDevice', () => {
    it('updates fields on an existing device', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 4, hostname: 'terminus', ip_address: '192.168.1.20',
          mac_address: 'aa:bb:cc:dd:ee:ff', status: 'online',
        }],
      });

      const result = await db.updateDevice(4, {
        ip_address: '192.168.1.20',
        mac_address: 'aa:bb:cc:dd:ee:ff',
      });

      expect(result).not.toBeNull();
      expect(result!.ip_address).toBe('192.168.1.20');
    });

    it('returns null when no updates provided', async () => {
      const result = await db.updateDevice(4, {});
      expect(result).toBeNull();
    });
  });

  describe('close', () => {
    it('closes the pool', async () => {
      const mocks = await getMocks();
      await db.close();
      expect(mocks.mockEnd).toHaveBeenCalled();
    });
  });
});
