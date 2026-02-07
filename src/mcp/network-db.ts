import pg from 'pg';

const { Pool } = pg;

export interface NetworkClient {
  id: number;
  hostname: string | null;
  ip_address: string;
  mac_address: string;
  device_type: string | null;
  connection_type: string | null;
  network: string | null;
  vlan_id: number | null;
  status: string | null;
  uptime_seconds: number | null;
  signal_strength: number | null;
  ssid: string | null;
  rx_bytes: number | null;
  tx_bytes: number | null;
  discovered_at: Date | null;
  last_seen: Date | null;
}

export interface Network {
  id: number;
  network_id: string;
  name: string;
  subnet: string | null;
  vlan_id: number | null;
  dhcp_enabled: boolean | null;
  purpose: string | null;
  discovered_at: Date | null;
  last_seen: Date | null;
}

export interface AddDeviceInput {
  hostname: string;
  ip_address: string;
  mac_address: string;
  device_type?: string;
  connection_type?: string;
  network?: string;
  vlan_id?: number;
}

export class NetworkDB {
  private pool: pg.Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString: connectionString ?? 'postgresql://cerebrus:cerebrus2025@100.69.42.106:5432/cerebrus',
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async lookupDevice(query: string): Promise<NetworkClient[]> {
    const result = await this.pool.query<NetworkClient>(
      `SELECT * FROM network_clients
       WHERE hostname ILIKE $1 OR ip_address::text LIKE $1 OR mac_address::text ILIKE $1
       ORDER BY hostname`,
      [`%${query.toLowerCase()}%`]
    );
    return result.rows;
  }

  async listDevices(filter?: { network?: string; device_type?: string }): Promise<NetworkClient[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter?.network) {
      conditions.push(`network = $${idx++}`);
      params.push(filter.network);
    }
    if (filter?.device_type) {
      conditions.push(`device_type = $${idx++}`);
      params.push(filter.device_type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<NetworkClient>(
      `SELECT * FROM network_clients ${where} ORDER BY hostname`,
      params
    );
    return result.rows;
  }

  async listNetworks(): Promise<Network[]> {
    const result = await this.pool.query<Network>(
      'SELECT * FROM networks ORDER BY name'
    );
    return result.rows;
  }

  async addDevice(input: AddDeviceInput): Promise<NetworkClient> {
    const result = await this.pool.query<NetworkClient>(
      `INSERT INTO network_clients (hostname, ip_address, mac_address, device_type, connection_type, network, vlan_id, status)
       VALUES ($1, $2::inet, $3::macaddr, $4, $5, $6, $7, 'online')
       RETURNING *`,
      [input.hostname, input.ip_address, input.mac_address, input.device_type ?? null,
       input.connection_type ?? null, input.network ?? null, input.vlan_id ?? null]
    );
    return result.rows[0];
  }

  async updateDevice(id: number, updates: Partial<Pick<NetworkClient, 'hostname' | 'ip_address' | 'mac_address' | 'device_type' | 'connection_type' | 'network' | 'vlan_id' | 'status'>>): Promise<NetworkClient | null> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        if (key === 'ip_address') {
          setClauses.push(`${key} = $${idx++}::inet`);
        } else if (key === 'mac_address') {
          setClauses.push(`${key} = $${idx++}::macaddr`);
        } else {
          setClauses.push(`${key} = $${idx++}`);
        }
        params.push(value);
      }
    }

    if (setClauses.length === 0) return null;

    setClauses.push(`last_seen = now()`);
    params.push(id);

    const result = await this.pool.query<NetworkClient>(
      `UPDATE network_clients SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] ?? null;
  }
}
