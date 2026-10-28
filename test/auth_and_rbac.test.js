import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../app.js';
import fs from 'node:fs';

describe('Authentication & Role-Based Access Control (RBAC)', () => {
  const TEST_DB = './test_auth_rbac.db';
  let server;
  let baseUrl;
  let adminToken;
  let viewerToken;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const app = createApp(TEST_DB);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
  });

  it('authenticates pre-seeded default admin account and returns valid JWT', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBeDefined();
    expect(data.user.username).toBe('admin');
    expect(data.user.role).toBe('admin');
    adminToken = data.token;
  });

  it('rejects login with invalid password', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrongpassword' }),
    });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe('AUTH_FAILED');
  });

  it('registers a new user with default viewer role', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'jane_viewer',
        email: 'jane@example.com',
        password: 'password123',
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.user.username).toBe('jane_viewer');
    expect(data.user.role).toBe('viewer');
    expect(data.token).toBeDefined();
    viewerToken = data.token;
  });

  it('rejects registration with duplicate username', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'jane_viewer',
        email: 'other@example.com',
        password: 'password123',
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe('REGISTRATION_FAILED');
    expect(data.error.message).toContain('already taken');
  });

  it('retrieves active profile via GET /auth/me with Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.username).toBe('jane_viewer');
    expect(data.user.role).toBe('viewer');
  });

  it('blocks unauthenticated request to PUT /devices/1/config with 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ angle_offset_deg: 5.0 }),
    });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe('UNAUTHORIZED');
  });

  it('blocks viewer user from modifying hardware calibration with 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({ angle_offset_deg: 5.0 }),
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe('FORBIDDEN');
    expect(data.error.message).toContain("requires 'admin' role");
  });

  it('allows administrator to modify hardware calibration with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ angle_offset_deg: 7.5 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.angle_offset_deg).toBe(7.5);
  });

  it('allows public read of calibration profile without authentication', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.device_id).toBe(1);
    expect(data.microphone_distance_m).toBeDefined();
  });

  it('blocks viewer from user management endpoint GET /users with 403', async () => {
    const res = await fetch(`${baseUrl}/api/v1/users`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });

    expect(res.status).toBe(403);
  });

  it('allows admin to list users and promote a viewer to admin', async () => {
    // 1. List users
    const listRes = await fetch(`${baseUrl}/api/v1/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.users.length).toBeGreaterThanOrEqual(2);

    const viewerUser = listData.users.find((u) => u.username === 'jane_viewer');
    expect(viewerUser).toBeDefined();

    // 2. Promote to admin
    const patchRes = await fetch(`${baseUrl}/api/v1/users/${viewerUser.id}/role`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ role: 'admin' }),
    });

    expect(patchRes.status).toBe(200);
    const patchData = await patchRes.json();
    expect(patchData.user.role).toBe('admin');
  });
});
