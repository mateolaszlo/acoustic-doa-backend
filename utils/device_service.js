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
}

export default DeviceService;
