import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../app.js';
import { encodeBinaryBatch, CLOCK_FLAG_UTC_SYNCHRONIZED } from '../utils/binary_parser.js';
import { sseBroadcaster } from '../utils/sse_broadcaster.js';
import http from 'node:http';
import fs from 'node:fs';

describe('Acoustic DOA REST API Endpoints', () => {
  const TEST_DB = './test_acoustic_doa.db';
  let server;
  let baseUrl;
  let adminToken;

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

    // Obtain admin token
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const loginData = await loginRes.json();
    adminToken = loginData.token;
  });

  afterAll(async () => {
    sseBroadcaster.close();
    await new Promise((resolve) => server.close(() => resolve()));
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
  });

  it('rejects calibration poll without x-api-key', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/calibration`);
    expect(res.status).toBe(401);
  });

  it('returns valid calibration and server time with x-api-key', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/calibration`, {
      headers: {
        'x-api-key': 'esp32-acoustic-doa-secret-key-1',
        Accept: 'application/json',
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.device_id).toBe(1);
    expect(data.microphone_distance_m).toBeCloseTo(0.082, 3);
    expect(data.sample_rate).toBe(44100);
    expect(data.window_size).toBe(1024);
    expect(typeof data.server_time_unix_ms).toBe('number');
  });

  it('accepts valid binary measurement batches and persists records', async () => {
    const baseMs = BigInt(Date.now());
    const records = [
      {
        offsetMs: 0,
        angleDeg: 30.0,
        delayUs: 60.0,
        soundLevelDb: 72.5,
        confidence: 0.88,
      },
      {
        offsetMs: 50,
        angleDeg: 35.0,
        delayUs: 68.0,
        soundLevelDb: 74.0,
        confidence: 0.92,
      },
    ];

    const buffer = encodeBinaryBatch(baseMs, CLOCK_FLAG_UTC_SYNCHRONIZED, records);

    const res = await fetch(`${baseUrl}/api/v1/measurements`, {
      method: 'POST',
      headers: {
        'x-api-key': 'esp32-acoustic-doa-secret-key-1',
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.accepted).toBe(2);
    expect(data.device_id).toBe(1);
  });

  it('rejects binary batches with corrupt CRC32 trailer with HTTP 400', async () => {
    const baseMs = BigInt(Date.now());
    const records = [
      {
        offsetMs: 0,
        angleDeg: 45.0,
        delayUs: 80.0,
        soundLevelDb: 65.0,
        confidence: 0.9,
      },
    ];

    const validBuffer = encodeBinaryBatch(baseMs, CLOCK_FLAG_UTC_SYNCHRONIZED, records);
    const corruptBuffer = Buffer.from(validBuffer);
    // Invalidate trailer CRC
    corruptBuffer[corruptBuffer.length - 1] ^= 0xFF;

    const res = await fetch(`${baseUrl}/api/v1/measurements`, {
      method: 'POST',
      headers: {
        'x-api-key': 'esp32-acoustic-doa-secret-key-1',
        'Content-Type': 'application/octet-stream',
      },
      body: corruptBuffer,
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe('INVALID_BINARY_PAYLOAD');
    expect(data.error.message).toContain('CRC32 checksum mismatch');
  });

  it('returns newly inserted records on GET /measurements/latest', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/measurements/latest?since_timestamp=0`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.records.length).toBe(2);
    expect(data.records[0].angle_deg).toBeCloseTo(30.0, 1);
    expect(data.records[1].angle_deg).toBeCloseTo(35.0, 1);
  });

  it('accepts maximum capacity 24-record binary batches (496 bytes) with valid CRC', async () => {
    const baseMs = BigInt(Date.now());
    const records = [];
    for (let i = 0; i < 24; i++) {
      records.push({
        offsetMs: i * 10,
        angleDeg: -180.0 + i * 15.0,
        delayUs: i * 3.0,
        soundLevelDb: 60.0 + (i % 15),
        confidence: 0.85,
      });
    }

    const buffer = encodeBinaryBatch(baseMs, CLOCK_FLAG_UTC_SYNCHRONIZED, records);
    expect(buffer.length).toBe(496); // 12 + 24*20 + 4

    const res = await fetch(`${baseUrl}/api/v1/measurements`, {
      method: 'POST',
      headers: {
        'x-api-key': 'esp32-acoustic-doa-secret-key-1',
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.accepted).toBe(24);
  });

  it('updates calibration configuration via PUT /config', async () => {
    const updateRes = await fetch(`${baseUrl}/api/v1/devices/1/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        angle_offset_deg: 12.5,
        sound_level_threshold_db: 58.0,
        adaptive_threshold_enabled: false,
      }),
    });

    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.angle_offset_deg).toBeCloseTo(12.5, 1);
    expect(updated.sound_level_threshold_db).toBeCloseTo(58.0, 1);
    expect(updated.adaptive_threshold_enabled).toBe(false);

    // Verify subsequent calibration poll reflects this immediately
    const pollRes = await fetch(`${baseUrl}/api/v1/devices/1/calibration`, {
      headers: { 'x-api-key': 'esp32-acoustic-doa-secret-key-1' },
    });
    const pollData = await pollRes.json();
    expect(pollData.angle_offset_deg).toBeCloseTo(12.5, 1);
  });

  it('computes acoustic statistics with 36 angular bins', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/stats?timeframe=24h`);
    expect(res.status).toBe(200);
    const stats = await res.json();
    expect(stats.angularBins36.length).toBe(36);
    expect(stats.eventCount).toBeGreaterThanOrEqual(2);
  });

  it('computes acoustic statistics respecting since_ms session filter', async () => {
    const futureMs = Date.now() + 100000;
    const res = await fetch(`${baseUrl}/api/v1/devices/1/stats?timeframe=24h&since_ms=${futureMs}`);
    expect(res.status).toBe(200);
    const stats = await res.json();
    expect(stats.eventCount).toBe(0);
    expect(stats.angularBins36.every((b) => b === 0)).toBe(true);
  });

  it('retrieves global all-time measurement count for a device', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/count`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device_id).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it('broadcasts real-time events to SSE subscribers on binary batch upload', async () => {
    // 1. Open SSE stream
    const sseChunks = [];

    const ssePromise = new Promise((resolve, reject) => {
      const clientReq = http.get(`${baseUrl}/api/v1/devices/1/stream`, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/event-stream');

        res.on('data', (chunk) => {
          const text = chunk.toString();
          sseChunks.push(text);
          if (text.includes('measurement_batch')) {
            res.destroy();
            clientReq.destroy();
            resolve();
          }
        });
        res.on('error', (err) => {
          if (err.code !== 'ECONNRESET') reject(err);
        });
      });
    });

    // Wait 50ms for SSE connection to establish
    await new Promise((r) => setTimeout(r, 50));

    // 2. Post a binary measurement batch
    const baseMs = BigInt(Date.now());
    const records = [
      {
        offsetMs: 10,
        angleDeg: -45.0,
        delayUs: -90.0,
        soundLevelDb: 80.0,
        confidence: 0.95,
      },
    ];
    const buffer = encodeBinaryBatch(baseMs, CLOCK_FLAG_UTC_SYNCHRONIZED, records);

    await fetch(`${baseUrl}/api/v1/measurements`, {
      method: 'POST',
      headers: {
        'x-api-key': 'esp32-acoustic-doa-secret-key-1',
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    });

    // 3. Wait for SSE event
    await ssePromise;

    const allData = sseChunks.join('');
    expect(allData).toContain('event: connected');
    expect(allData).toContain('event: measurement_batch');
    expect(allData).toContain('-45');
  });
});
