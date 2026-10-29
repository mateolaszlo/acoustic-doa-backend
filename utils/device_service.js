import crypto from 'node:crypto';

export class DeviceService {
  constructor(db) {
    this.db = db;
  }

  authenticateDevice(apiKey) {
    if (!apiKey) return null;

    const stmt = this.db.prepare('SELECT id, name, api_key FROM devices');
    const devices = stmt.all();

    for (const d of devices) {
      if (d.api_key.length === apiKey.length) {
        if (crypto.timingSafeEqual(Buffer.from(d.api_key), Buffer.from(apiKey))) {
          return { id: d.id, name: d.name };
        }
      }
    }
    return null;
  }

  updateDeviceHeartbeat(deviceId, clockStatus) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE devices
      SET last_seen_at = ?, clock_status = ?
      WHERE id = ?
    `);
    stmt.run(now, clockStatus, deviceId);
  }

  listDevices() {
    const stmt = this.db.prepare(`
      SELECT d.id, d.name, d.last_seen_at, d.clock_status, d.firmware_version,
             c.sample_rate
      FROM devices d
      LEFT JOIN device_calibration c ON d.id = c.device_id
      ORDER BY d.id ASC
    `);
    const rows = stmt.all();

    const nowMs = Date.now();
    return rows.map((r) => {
      const lastSeenMs = r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0;
      // Device is considered online if seen within last 120 seconds
      const isOnline = nowMs - lastSeenMs < 120000;
      return {
        id: r.id,
        name: r.name,
        status: isOnline ? 'online' : 'offline',
        last_seen_at: r.last_seen_at,
        clock_status: r.clock_status,
        sample_rate: r.sample_rate || 44100,
      };
    });
  }

  listDevicesAdmin() {
    const stmt = this.db.prepare(`
      SELECT d.id, d.name, d.api_key, d.created_at, d.last_seen_at, d.clock_status, d.firmware_version,
             c.sample_rate,
             (SELECT COUNT(*) FROM measurements WHERE device_id = d.id) as total_events
      FROM devices d
      LEFT JOIN device_calibration c ON d.id = c.device_id
      ORDER BY d.id ASC
    `);
    const rows = stmt.all();

    const nowMs = Date.now();
    return rows.map((r) => {
      const lastSeenMs = r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0;
      const isOnline = nowMs - lastSeenMs < 120000;
      return {
        id: r.id,
        name: r.name,
        api_key: r.api_key,
        status: isOnline ? 'online' : 'offline',
        created_at: r.created_at,
        last_seen_at: r.last_seen_at,
        clock_status: r.clock_status,
        firmware_version: r.firmware_version,
        sample_rate: r.sample_rate || 44100,
        total_events: r.total_events || 0,
      };
    });
  }

  getDevice(id) {
    const stmt = this.db.prepare(`
      SELECT d.id, d.name, d.api_key, d.created_at, d.last_seen_at, d.clock_status, d.firmware_version,
             c.sample_rate,
             (SELECT COUNT(*) FROM measurements WHERE device_id = d.id) as total_events
      FROM devices d
      LEFT JOIN device_calibration c ON d.id = c.device_id
      WHERE d.id = ?
    `);
    const r = stmt.get(id);
    if (!r) return null;
    const nowMs = Date.now();
    const lastSeenMs = r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0;
    return {
      id: r.id,
      name: r.name,
      api_key: r.api_key,
      status: nowMs - lastSeenMs < 120000 ? 'online' : 'offline',
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      clock_status: r.clock_status,
      firmware_version: r.firmware_version,
      sample_rate: r.sample_rate || 44100,
      total_events: r.total_events || 0,
    };
  }

  createDevice({ name, apiKey }) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Device name is required');
    }

    const key =
      apiKey && apiKey.trim().length > 0
        ? apiKey.trim()
        : `esp32-acoustic-doa-secret-key-${crypto.randomBytes(6).toString('hex')}`;

    const now = new Date().toISOString();

    const insertDevice = this.db.prepare(`
      INSERT INTO devices (name, api_key, created_at, last_seen_at, clock_status, firmware_version)
      VALUES (?, ?, ?, ?, 'UNKNOWN', '1.0.0')
    `);

    const insertCalib = this.db.prepare(`
      INSERT INTO device_calibration (
        device_id, microphone_distance_m, sample_rate, window_size,
        correlation_threshold, sound_level_threshold_db, db_spl_offset,
        angle_offset_deg, adaptive_threshold_enabled, snr_margin_db, updated_at
      ) VALUES (?, 0.082, 44100, 1024, 0.40, 55.0, 96.5, 0.0, 1, 8.0, ?)
    `);

    let newId;
    this.db.transaction(() => {
      const result = insertDevice.run(name.trim(), key, now, now);
      newId = Number(result.lastInsertRowid);
      insertCalib.run(newId, now);
    })();

    return this.getDevice(newId);
  }

  updateDevice(id, { name }) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Device name is required');
    }
    const stmt = this.db.prepare('UPDATE devices SET name = ? WHERE id = ?');
    const result = stmt.run(name.trim(), id);
    if (result.changes === 0) {
      throw new Error(`Device ${id} not found`);
    }
    return this.getDevice(id);
  }

  rotateApiKey(id) {
    const newKey = `esp32-acoustic-doa-secret-key-${crypto.randomBytes(6).toString('hex')}`;
    const stmt = this.db.prepare('UPDATE devices SET api_key = ? WHERE id = ?');
    const result = stmt.run(newKey, id);
    if (result.changes === 0) {
      throw new Error(`Device ${id} not found`);
    }
    return { id, api_key: newKey, message: 'API key successfully rotated' };
  }

  deleteDevice(id) {
    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM devices');
    if (countStmt.get().count <= 1) {
      throw new Error('Cannot delete the only remaining device node');
    }
    const stmt = this.db.prepare('DELETE FROM devices WHERE id = ?');
    const result = stmt.run(id);
    if (result.changes === 0) {
      throw new Error(`Device ${id} not found`);
    }
    return { success: true, message: `Device ${id} deleted successfully` };
  }
}

export default DeviceService;
