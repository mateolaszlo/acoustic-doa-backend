import crypto from 'node:crypto';
import { insertDefaultCalibration } from './db.js';

const DEVICE_ONLINE_THRESHOLD_MS = 120000;

const ADMIN_DEVICE_SELECT = `
  SELECT d.id, d.name, d.api_key, d.created_at, d.last_seen_at, d.clock_status, d.firmware_version,
         c.sample_rate,
         (SELECT COUNT(*) FROM measurements WHERE device_id = d.id) as total_events
  FROM devices d
  LEFT JOIN device_calibration c ON d.id = c.device_id
`;

function mapDeviceRow(row, nowMs, includeAdmin) {
  const lastSeenMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  const base = {
    id: row.id,
    name: row.name,
    status: nowMs - lastSeenMs < DEVICE_ONLINE_THRESHOLD_MS ? 'online' : 'offline',
    last_seen_at: row.last_seen_at,
    clock_status: row.clock_status,
    sample_rate: row.sample_rate || 44100,
  };

  if (!includeAdmin) {
    return base;
  }

  return {
    ...base,
    api_key: row.api_key,
    created_at: row.created_at,
    firmware_version: row.firmware_version,
    total_events: row.total_events || 0,
  };
}

export class DeviceService {
  constructor(db) {
    this.db = db;
  }

  authenticateDevice(apiKey) {
    if (!apiKey) return null;

    const devices = this.db.prepare('SELECT id, name, api_key FROM devices').all();
    for (const d of devices) {
      if (d.api_key.length === apiKey.length && crypto.timingSafeEqual(Buffer.from(d.api_key), Buffer.from(apiKey))) {
        return { id: d.id, name: d.name };
      }
    }
    return null;
  }

  updateDeviceHeartbeat(deviceId, clockStatus) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE devices
      SET last_seen_at = ?, clock_status = ?
      WHERE id = ?
    `).run(now, clockStatus, deviceId);
  }

  listDevices() {
    const rows = this.db.prepare(`
      SELECT d.id, d.name, d.last_seen_at, d.clock_status, c.sample_rate
      FROM devices d
      LEFT JOIN device_calibration c ON d.id = c.device_id
      ORDER BY d.id ASC
    `).all();
    const nowMs = Date.now();
    return rows.map((row) => mapDeviceRow(row, nowMs, false));
  }

  listDevicesAdmin() {
    const rows = this.db.prepare(`${ADMIN_DEVICE_SELECT} ORDER BY d.id ASC`).all();
    const nowMs = Date.now();
    return rows.map((row) => mapDeviceRow(row, nowMs, true));
  }

  getDevice(id) {
    const row = this.db.prepare(`${ADMIN_DEVICE_SELECT} WHERE d.id = ?`).get(id);
    return row ? mapDeviceRow(row, Date.now(), true) : null;
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

    let newId;
    this.db.transaction(() => {
      const result = insertDevice.run(name.trim(), key, now, now);
      newId = Number(result.lastInsertRowid);
      insertDefaultCalibration(this.db, newId, now);
    })();

    return this.getDevice(newId);
  }

  updateDevice(id, { name }) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Device name is required');
    }
    const result = this.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name.trim(), id);
    if (result.changes === 0) {
      throw new Error(`Device ${id} not found`);
    }
    return this.getDevice(id);
  }

  rotateApiKey(id) {
    const newKey = `esp32-acoustic-doa-secret-key-${crypto.randomBytes(6).toString('hex')}`;
    const result = this.db.prepare('UPDATE devices SET api_key = ? WHERE id = ?').run(newKey, id);
    if (result.changes === 0) {
      throw new Error(`Device ${id} not found`);
    }
    return { id, api_key: newKey, message: 'API key successfully rotated' };
  }

  deleteDevice(id) {
    if (this.db.prepare('SELECT COUNT(*) as count FROM devices').get().count <= 1) {
      throw new Error('Cannot delete the only remaining device node');
    }
    const result = this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    if (result.changes === 0) {
      throw new Error(`Device ${id} not found`);
    }
    return { success: true, message: `Device ${id} deleted successfully` };
  }
}
