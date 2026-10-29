import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';

describe('Admin Device & API Key Management REST Endpoints', () => {
  let server;
  let baseUrl;
  const testDbPath = path.join(process.cwd(), 'test_devices_admin.db');
  let adminToken;
  let viewerToken;

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const app = createApp(testDbPath);
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // 1. Authenticate default admin
    const adminRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const adminData = await adminRes.json();
    adminToken = adminData.token;

    // 2. Register viewer user
    const viewerRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'testviewer',
        email: 'viewer@example.com',
        password: 'ViewerPassword123!',
      }),
    });
    const viewerData = await viewerRes.json();
    viewerToken = viewerData.token;
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('public GET /devices returns sanitized device list without api_key', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices`);
    expect(res.status).toBe(200);
    const devices = await res.json();
    expect(devices.length).toBeGreaterThanOrEqual(1);
    expect(devices[0].id).toBe(1);
    expect(devices[0].name).toBeDefined();
    expect(devices[0].api_key).toBeUndefined(); // Must not be exposed to public!
  });

  it('admin GET /devices returns administrative details with api_key and total_events', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const devices = await res.json();
    expect(devices.length).toBeGreaterThanOrEqual(1);
    expect(devices[0].api_key).toBeDefined();
    expect(devices[0].total_events).toBeDefined();
  });

  it('blocks viewer from creating a new device with 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({ name: 'Unauthorized Node' }),
    });
    expect(res.status).toBe(403);
  });

  it('allows administrator to register a new ESP32 array node', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ name: 'ESP32 Array #2 (Anechoic Lab)' }),
    });
    expect(res.status).toBe(201);
    const device = await res.json();
    expect(device.id).toBe(2);
    expect(device.name).toBe('ESP32 Array #2 (Anechoic Lab)');
    expect(device.api_key).toMatch(/^esp32-acoustic-doa-secret-key-/);

    // Verify auto-seeded calibration profile
    const calibRes = await fetch(`${baseUrl}/api/v1/devices/2/config`);
    expect(calibRes.status).toBe(200);
    const calib = await calibRes.json();
    expect(calib.device_id).toBe(2);
    expect(calib.microphone_distance_m).toBe(0.082);
  });

  it('allows administrator to rename a node via PUT /devices/:id', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/2`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ name: 'ESP32 Array #2 (Renamed)' }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe('ESP32 Array #2 (Renamed)');
  });

  it('allows administrator to rotate a node API key', async () => {
    const oldRes = await fetch(`${baseUrl}/api/v1/devices`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const oldDevices = await oldRes.json();
    const oldKey = oldDevices.find((d) => d.id === 2).api_key;

    const res = await fetch(`${baseUrl}/api/v1/devices/2/api-key/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.api_key).toBeDefined();
    expect(result.api_key).not.toBe(oldKey);

    // Verify device can authenticate with new key
    const pollRes = await fetch(`${baseUrl}/api/v1/devices/2/calibration`, {
      headers: { 'x-api-key': result.api_key },
    });
    expect(pollRes.status).toBe(200);
  });

  it('allows administrator to purge measurements for a node', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/2/measurements`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.success).toBe(true);
    expect(result.deleted_records).toBe(0);
  });

  it('allows administrator to delete a node when multiple exist', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/2`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.success).toBe(true);

    // Verify device 2 no longer exists
    const listRes = await fetch(`${baseUrl}/api/v1/devices`);
    const list = await listRes.json();
    expect(list.find((d) => d.id === 2)).toBeUndefined();
  });

  it('prevents administrator from deleting the only remaining device node', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.error.message).toContain('only remaining device');
  });
});
