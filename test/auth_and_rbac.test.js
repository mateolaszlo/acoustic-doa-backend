import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../app.js';
import fs from 'node:fs';

import http from 'node:http';

describe('Authentication & Role-Based Access Control (RBAC)', () => {
  const TEST_DB = './test_auth_rbac.db';
  let server;
  let baseUrl;
  let adminToken;
  let viewerToken;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const app = createApp(TEST_DB, { authRateLimit: { max: 50, windowMs: 60000 } });
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

  it('blocks unauthenticated reads of protected dashboard and SSE endpoints with 401', async () => {
    const protectedGets = [
      '/api/v1/devices',
      '/api/v1/devices/1/config',
      '/api/v1/devices/1/zones',
      '/api/v1/devices/1/studio',
      '/api/v1/devices/1/tracks',
      '/api/v1/devices/1/measurements',
      '/api/v1/devices/1/measurements/latest',
      '/api/v1/devices/1/count',
      '/api/v1/devices/1/stats',
      '/api/v1/devices/1/stream',
    ];

    for (const endpoint of protectedGets) {
      const res = await fetch(`${baseUrl}${endpoint}`);
      expect(res.status, `Expected 401 for unauthenticated GET ${endpoint}`).toBe(401);
    }

    // Authenticated viewer can read config
    const viewerRes = await fetch(`${baseUrl}/api/v1/devices/1/config`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    expect(viewerRes.status).toBe(200);
    const data = await viewerRes.json();
    expect(data.device_id).toBe(1);
    expect(data.microphone_distance_m).toBeDefined();
  });

  it('authenticates pre-seeded viewer account and supports HttpOnly cookie sessions for REST, SSE & logout', async () => {
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'viewer', password: 'viewer123' }),
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get('set-cookie') || '';
    expect(setCookie).toContain('acoustic_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const cookiePair = setCookie.split(';')[0];

    // Authenticate REST call using only HttpOnly cookie
    const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Cookie: cookiePair },
    });
    expect(meRes.status).toBe(200);
    const meData = await meRes.json();
    expect(meData.user.username).toBe('viewer');
    expect(meData.user.role).toBe('viewer');

    // Authenticate SSE stream using only HttpOnly cookie
    const controller = new AbortController();
    try {
      const sseRes = await fetch(`${baseUrl}/api/v1/devices/1/stream`, {
        signal: controller.signal,
        headers: { Cookie: cookiePair },
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    } finally {
      controller.abort();
    }

    // Logout clears session cookie
    const logoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, { method: 'POST' });
    expect(logoutRes.status).toBe(200);
    const clearedCookie = logoutRes.headers.get('set-cookie') || '';
    expect(clearedCookie).toContain('acoustic_session=;');
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

  it('rejects weak/oversized passwords, untrusted CORS origins, deleted user tokens, and enforces rate limits', async () => {
    // 1. Password length bounds (<8 chars rejected)
    const weakRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'weakuser', email: 'weak@test.local', password: '1234567' }),
    });
    expect(weakRes.status).toBe(400);

    // 2. Untrusted CORS origin rejected with 403
    const corsRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil-attacker.example',
      },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    expect(corsRes.status).toBe(403);
    const corsErr = await corsRes.json();
    expect(corsErr.error.code).toBe('CORS_FORBIDDEN');

    // 3. Deleted user JWT immediately invalidated (live DB user check)
    const tempReg = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ephemeral_user', email: 'eph@test.local', password: 'password123' }),
    });
    expect(tempReg.status).toBe(201);
    const tempData = await tempReg.json();

    const delRes = await fetch(`${baseUrl}/api/v1/users/${tempData.user.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(200);

    const revokedRes = await fetch(`${baseUrl}/api/v1/devices/1/studio`, {
      headers: { Authorization: `Bearer ${tempData.token}` },
    });
    expect(revokedRes.status).toBe(401);

    // 4. Rate limiting on isolated app instance with max: 2
    const rlDb = './test_auth_rl.db';
    if (fs.existsSync(rlDb)) fs.unlinkSync(rlDb);
    const rlApp = createApp(rlDb, { authRateLimit: { max: 2, windowMs: 60000 } });
    const rlServer = http.createServer(rlApp);
    await new Promise((r) => rlServer.listen(0, '127.0.0.1', r));
    const rlUrl = `http://127.0.0.1:${rlServer.address().port}`;
    try {
      for (let i = 0; i < 2; i++) {
        const attempt = await fetch(`${rlUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'wrong' }),
        });
        expect(attempt.status).toBe(401);
      }
      const blocked = await fetch(`${rlUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      });
      expect(blocked.status).toBe(429);
      const rlErr = await blocked.json();
      expect(rlErr.error.code).toBe('TOO_MANY_REQUESTS');
    } finally {
      await new Promise((r) => rlServer.close(r));
      for (const s of ['', '-wal', '-shm']) {
        if (fs.existsSync(rlDb + s)) fs.unlinkSync(rlDb + s);
      }
    }
  });

  it('broadcasts zones_config and device_config events over SSE when admin updates them', async () => {
    const eventsReceived = [];
    const ssePromise = new Promise((resolve, reject) => {
      const req = http.get(
        `${baseUrl}/api/v1/devices/1/stream`,
        { headers: { Authorization: `Bearer ${viewerToken}` } },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.on('data', (chunk) => {
            const text = chunk.toString();
            eventsReceived.push(text);
            const joined = eventsReceived.join('');
            if (joined.includes('event: zones_config') && joined.includes('event: device_config')) {
              res.destroy();
              req.destroy();
              resolve();
            }
          });
          res.on('error', (err) => {
            if (err.code !== 'ECONNRESET') reject(err);
          });
        }
      );
    });

    await new Promise((r) => setTimeout(r, 50));

    const zRes = await fetch(`${baseUrl}/api/v1/devices/1/zones`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify([
        { name: 'Test Sector', min_angle_deg: -20, max_angle_deg: 20, color: '#10b981', alert_threshold_db: 70 },
      ]),
    });
    expect(zRes.status).toBe(200);

    const cRes = await fetch(`${baseUrl}/api/v1/devices/1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ angle_offset_deg: 4.0 }),
    });
    expect(cRes.status).toBe(200);

    await ssePromise;
    const joined = eventsReceived.join('');
    expect(joined).toContain('event: zones_config');
    expect(joined).toContain('event: device_config');
  });
});
