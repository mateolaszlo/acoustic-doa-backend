import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import { initDatabase } from '../utils/db.js';
import { encodeBinaryBatch, CLOCK_FLAG_UTC_SYNCHRONIZED } from '../utils/binary_parser.js';
import { PTZDirectorService } from '../utils/ptz_director_service.js';
import { MultiTargetTracker } from '../utils/multi_target_tracker.js';
import { MeasurementService } from '../utils/measurement_service.js';
import { sseBroadcaster } from '../utils/sse_broadcaster.js';

describe('Backend Error Handling & Fault Isolation', () => {
  let server;
  let baseUrl;
  let db;
  const testDbPath = path.join(process.cwd(), 'test_error_handling.db');

  beforeAll(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${testDbPath}${suffix}`;
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }

    const app = createApp(testDbPath);
    db = initDatabase(testDbPath);

    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (db) {
      try {
        db.close();
      } catch {}
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${testDbPath}${suffix}`;
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }
  });

  it('returns 400 INVALID_JSON with err.message on malformed JSON body', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"username": "admin", "password": ',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_JSON');
    expect(body.error.status).toBe(400);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  describe('Strict :device_id validation across routes', () => {
    const deviceEndpoints = [
      '/api/v1/devices/{id}/measurements',
      '/api/v1/devices/{id}/measurements/latest',
      '/api/v1/devices/{id}/tracks',
      '/api/v1/devices/{id}/count',
      '/api/v1/devices/{id}/stats',
      '/api/v1/devices/{id}/config',
      '/api/v1/devices/{id}/studio',
      '/api/v1/devices/{id}/zones',
    ];

    it.each(['abc', '1abc', '0'])(
      'rejects invalid device_id "%s" with 400 INVALID_DEVICE_ID across REST endpoints',
      async (badId) => {
        for (const template of deviceEndpoints) {
          const url = `${baseUrl}${template.replace('{id}', badId)}`;
          const res = await fetch(url);
          expect(res.status, `Expected 400 for ${url}`).toBe(400);
          const body = await res.json();
          expect(body.error.code).toBe('INVALID_DEVICE_ID');
          expect(body.error.status).toBe(400);
        }
      }
    );

    it('rejects non-numeric /devices/abc/stream with 400 INVALID_DEVICE_ID', async () => {
      const res = await fetch(`${baseUrl}/api/v1/devices/abc/stream`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_DEVICE_ID');
    });

    it('allows wildcard /devices/0/stream and connects cleanly with 200', async () => {
      const controller = new AbortController();
      try {
        const res = await fetch(`${baseUrl}/api/v1/devices/0/stream`, {
          signal: controller.signal,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
      } finally {
        controller.abort();
      }
    });
  });

  it('isolates tracker and director failures on POST /measurements and still persists raw records', async () => {
    const beforeRes = await fetch(`${baseUrl}/api/v1/devices/1/count`);
    expect(beforeRes.status).toBe(200);
    const beforeCount = (await beforeRes.json()).total;

    const trackerSpy = vi
      .spyOn(MultiTargetTracker.prototype, 'processBatch')
      .mockImplementation(() => {
        throw new Error('Simulated tracker explosion');
      });
    const directorSpy = vi
      .spyOn(PTZDirectorService.prototype, 'processBatch')
      .mockImplementation(() => {
        throw new Error('Simulated director explosion');
      });

    try {
      const payload = encodeBinaryBatch(BigInt(Date.now()), CLOCK_FLAG_UTC_SYNCHRONIZED, [
        { offsetMs: 0, angleDeg: 15.0, soundLevelDb: 68.0, confidence: 0.9, slotId: 0 },
        { offsetMs: 40, angleDeg: 18.0, soundLevelDb: 69.0, confidence: 0.9, slotId: 0 },
      ]);

      const res = await fetch(`${baseUrl}/api/v1/measurements`, {
        method: 'POST',
        headers: {
          'x-api-key': 'esp32-acoustic-doa-secret-key-1',
          'Content-Type': 'application/octet-stream',
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.accepted).toBe(2);

      const afterRes = await fetch(`${baseUrl}/api/v1/devices/1/count`);
      expect(afterRes.status).toBe(200);
      const afterCount = (await afterRes.json()).total;
      expect(afterCount).toBe(beforeCount + 2);
    } finally {
      trackerSpy.mockRestore();
      directorSpy.mockRestore();
    }
  });

  it('returns structured 500 DATABASE_ERROR preserving err.message on SQLite failure', async () => {
    const countSpy = vi
      .spyOn(MeasurementService.prototype, 'getTotalCount')
      .mockImplementation(() => {
        throw new Error('Simulated SQLite read failure');
      });

    try {
      const res = await fetch(`${baseUrl}/api/v1/devices/1/count`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('DATABASE_ERROR');
      expect(body.error.status).toBe(500);
      expect(body.error.message).toBe('Simulated SQLite read failure');
    } finally {
      countSpy.mockRestore();
    }
  });

  it('recovers gracefully to defaults when device_studio_config JSON in SQLite is corrupted', async () => {
    db.prepare(
      `UPDATE device_studio_config
       SET room_layout_json = ?, cameras_json = ?, director_config_json = ?
       WHERE device_id = 1`
    ).run('{bad json', '[corrupted', '{"not":valid');

    const res = await fetch(`${baseUrl}/api/v1/devices/1/studio`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deviceId).toBe(1);
    expect(body.roomLayout).toBeDefined();
    expect(typeof body.roomLayout.tableShape).toBe('string');
    expect(Array.isArray(body.cameras)).toBe(true);
    expect(body.cameras.length).toBeGreaterThan(0);
    expect(body.directorConfig).toBeDefined();
    expect(typeof body.directorConfig.holdTimeMs).toBe('number');
  });

  it('returns false without throwing when sseBroadcaster.broadcastBatch receives unserializable BigInt data', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/v1/devices/0/stream`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    try {
      let thrown = false;
      let result;
      try {
        result = sseBroadcaster.broadcastBatch(1, {
          batchTimestamp: 123n,
          records: [{ value: 99n }],
        });
      } catch {
        thrown = true;
      }
      expect(thrown).toBe(false);
      expect(result).toBe(false);
    } finally {
      controller.abort();
    }
  });
});
