import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import { initDatabase } from '../utils/db.js';
import { SpatialZoneService } from '../utils/spatial_zone_service.js';

describe('Spatial Zones REST API & Service', () => {
  let server;
  let baseUrl;
  const testDbPath = path.join(process.cwd(), 'test_spatial_zones.db');
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
        username: 'zonewatcher',
        email: 'zones@example.com',
        password: 'WatcherPassword123!',
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

  it('GET /devices/1/zones returns default seeded spatial zones without authentication', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/zones`);
    expect(res.status).toBe(200);
    const zones = await res.json();
    expect(Array.isArray(zones)).toBe(true);
    expect(zones.length).toBe(4);

    const names = zones.map((z) => z.name);
    expect(names).toContain('Podium / Stage');
    expect(names).toContain('Audience Left');
    expect(names).toContain('Audience Right');
    expect(names).toContain('Rear Gallery');

    const podium = zones.find((z) => z.name === 'Podium / Stage');
    expect(podium.min_angle_deg).toBe(-30.0);
    expect(podium.max_angle_deg).toBe(30.0);
    expect(podium.color).toBe('#10b981');
    expect(podium.alert_threshold_db).toBe(75.0);
  });

  it('GET /devices/999/zones returns 404 for non-existent device', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/999/zones`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe('DEVICE_NOT_FOUND');
  });

  it('PUT /devices/1/zones rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/zones`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });
    expect(res.status).toBe(401);
  });

  it('PUT /devices/1/zones rejects viewer role with 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/zones`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify([]),
    });
    expect(res.status).toBe(403);
  });

  it('PUT /devices/1/zones rejects invalid angle boundaries with 400', async () => {
    const invalidZones = [
      { name: 'Invalid Inverted Zone', min_angle_deg: 50.0, max_angle_deg: 20.0 },
    ];
    const res = await fetch(`${baseUrl}/api/v1/devices/1/zones`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(invalidZones),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe('INVALID_ZONE_CONFIG');
    expect(data.error.message).toContain('must be strictly less than max_angle_deg');
  });

  it('PUT /devices/1/zones allows admin to update spatial zones and retrieve them', async () => {
    const newZones = [
      { name: 'Main Speaker', min_angle_deg: -20.0, max_angle_deg: 20.0, color: '#3b82f6', alert_threshold_db: 80.0 },
      { name: 'VIP Booth', min_angle_deg: 45.0, max_angle_deg: 85.0, color: '#ec4899', alert_threshold_db: 70.0 },
    ];

    const putRes = await fetch(`${baseUrl}/api/v1/devices/1/zones`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(newZones),
    });
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.success).toBe(true);
    expect(putData.zones.length).toBe(2);

    // Verify GET reflects the changes
    const getRes = await fetch(`${baseUrl}/api/v1/devices/1/zones`);
    expect(getRes.status).toBe(200);
    const fetchedZones = await getRes.json();
    expect(fetchedZones.length).toBe(2);
    expect(fetchedZones[0].name).toBe('Main Speaker');
    expect(fetchedZones[1].name).toBe('VIP Booth');
    expect(fetchedZones[1].color).toBe('#ec4899');
    expect(fetchedZones[1].alert_threshold_db).toBe(70.0);
  });

  it('SpatialZoneService direct unit tests for edge conditions', () => {
    const db = initDatabase(':memory:');
    const service = new SpatialZoneService(db);

    // Non-array input
    const badInput = service.updateZones(1, 'not-an-array');
    expect(badInput.success).toBe(false);

    // Empty zone name
    const emptyName = service.updateZones(1, [{ name: '', min_angle_deg: -10, max_angle_deg: 10 }]);
    expect(emptyName.success).toBe(false);

    // Out of range angles
    const outOfRange = service.updateZones(1, [{ name: 'Test', min_angle_deg: -200, max_angle_deg: 10 }]);
    expect(outOfRange.success).toBe(false);

    // Out of range threshold
    const outOfRangeDb = service.updateZones(1, [{ name: 'Test', min_angle_deg: -10, max_angle_deg: 10, alert_threshold_db: 200 }]);
    expect(outOfRangeDb.success).toBe(false);

    // Successful update
    const valid = service.updateZones(1, [
      { name: 'Boardroom Center', min_angle_deg: -45, max_angle_deg: 45, color: '#10b981' },
    ]);
    expect(valid.success).toBe(true);
    expect(valid.zones.length).toBe(1);
    expect(valid.zones[0].name).toBe('Boardroom Center');
  });
});
