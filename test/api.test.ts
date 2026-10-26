import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { encodeBinaryBatch } from '../src/protocol/binary_parser.js';
import { CLOCK_FLAG_UTC_SYNCHRONIZED } from '../src/protocol/binary_types.js';
import { sseBroadcaster } from '../src/services/sse_broadcaster.js';
import http from 'node:http';
import fs from 'node:fs';

describe('Acoustic DOA REST API Endpoints', () => {
  const TEST_DB = './test_acoustic_doa.db';
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const app = createApp(TEST_DB);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    sseBroadcaster.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    const data = (await res.json()) as any;
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
    const data = (await res.json()) as any;
    expect(data.status).toBe('success');
    expect(data.accepted).toBe(2);
    expect(data.device_id).toBe(1);
  });

  it('returns newly inserted records on GET /measurements/latest', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/measurements/latest?since_timestamp=0`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.records.length).toBe(2);
    expect(data.records[0].angle_deg).toBeCloseTo(30.0, 1);
    expect(data.records[1].angle_deg).toBeCloseTo(35.0, 1);
  });

  it('updates calibration configuration via PUT /config', async () => {
    const updateRes = await fetch(`${baseUrl}/api/v1/devices/1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        angle_offset_deg: 12.5,
        sound_level_threshold_db: 58.0,
        adaptive_threshold_enabled: false,
      }),
    });

    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as any;
    expect(updated.angle_offset_deg).toBeCloseTo(12.5, 1);
    expect(updated.sound_level_threshold_db).toBeCloseTo(58.0, 1);
    expect(updated.adaptive_threshold_enabled).toBe(false);

    // Verify subsequent calibration poll reflects this immediately
    const pollRes = await fetch(`${baseUrl}/api/v1/devices/1/calibration`, {
      headers: { 'x-api-key': 'esp32-acoustic-doa-secret-key-1' },
    });
    const pollData = (await pollRes.json()) as any;
    expect(pollData.angle_offset_deg).toBeCloseTo(12.5, 1);
  });

  it('computes acoustic statistics with 36 angular bins', async () => {
    const res = await fetch(`${baseUrl}/api/v1/devices/1/stats?timeframe=24h`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as any;
    expect(stats.angularBins36.length).toBe(36);
    expect(stats.eventCount).toBeGreaterThanOrEqual(2);
  });

  it('broadcasts real-time events to SSE subscribers on binary batch upload', async () => {
    // 1. Open SSE stream
    const sseChunks: string[] = [];
    const controller = new AbortController();

    const ssePromise = new Promise<void>((resolve, reject) => {
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
        res.on('error', (err: any) => {
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
    controller.abort();
  });
});
