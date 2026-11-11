import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import { encodeBinaryBatch, CLOCK_FLAG_UTC_SYNCHRONIZED } from '../utils/binary_parser.js';
import {
  calculateTablePerimeterPos,
  calculateCameraBearing,
  scoreCameraCandidate,
  resolveSpatialZone,
  wrapAngle180,
  BASE_ROOM_WIDTH,
  BASE_ROOM_HEIGHT,
  BASE_ROOM_CENTER_X,
  BASE_ROOM_CENTER_Y,
} from '../utils/ptz_director_service.js';

describe('Studio Configuration & Authoritative PTZ Director Engine', () => {
  let server;
  let baseUrl;
  const testDbPath = path.join(process.cwd(), 'test_studio_director.db');
  let adminToken;
  let viewerToken;

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {}
    }

    const app = createApp(testDbPath);
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // 1. Authenticate default admin
    const adminLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    expect(adminLoginRes.status).toBe(200);
    const adminData = await adminLoginRes.json();
    adminToken = adminData.token;

    // 2. Register viewer
    const viewerRegRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'viewer_studio', email: 'viewer_studio@test.local', password: 'password123' }),
    });
    expect(viewerRegRes.status).toBe(201);
    const viewerData = await viewerRegRes.json();
    viewerToken = viewerData.token;
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {}
    }
  });

  describe('Pure Geometric PTZ Math', () => {
    it('wraps angles properly into [-180, 180)', () => {
      expect(wrapAngle180(0)).toBe(0);
      expect(wrapAngle180(180)).toBe(-180);
      expect(wrapAngle180(-180)).toBe(-180);
      expect(wrapAngle180(270)).toBe(-90);
      expect(wrapAngle180(-270)).toBe(90);
    });

    it('calculates camera bearings with zero-North convention', () => {
      // Camera at (425, 200), target North at (425, 100) -> Bearing 0°
      expect(calculateCameraBearing(425, 200, 425, 100)).toBeCloseTo(0, 1);
      // Target East at (525, 200) -> Bearing +90°
      expect(calculateCameraBearing(425, 200, 525, 200)).toBeCloseTo(90, 1);
      // Target South at (425, 300) -> Bearing 180° / -180°
      expect(Math.abs(calculateCameraBearing(425, 200, 425, 300))).toBeCloseTo(180, 1);
      // Target West at (325, 200) -> Bearing -90°
      expect(calculateCameraBearing(425, 200, 325, 200)).toBeCloseTo(-90, 1);
    });

    it('calculates shape-aware table perimeter positions for round and oval tables', () => {
      const ovalLayout = { tableShape: 'oval', tableWidthRatio: 0.5, tableHeightRatio: 0.3, seatCount: 8 };
      const posNorth = calculateTablePerimeterPos(BASE_ROOM_CENTER_X, BASE_ROOM_CENTER_Y, 0, ovalLayout);
      expect(posNorth.x).toBeCloseTo(BASE_ROOM_CENTER_X, 1);
      expect(posNorth.y).toBeLessThan(BASE_ROOM_CENTER_Y);

      const roundLayout = { tableShape: 'round', tableWidthRatio: 0.5, tableHeightRatio: 0.5, seatCount: 8 };
      const posEast = calculateTablePerimeterPos(BASE_ROOM_CENTER_X, BASE_ROOM_CENTER_Y, 90, roundLayout);
      expect(posEast.x).toBeGreaterThan(BASE_ROOM_CENTER_X);
      expect(posEast.y).toBeCloseTo(BASE_ROOM_CENTER_Y, 1);
    });

    it('snaps to custom chair coordinate when within 25 degrees', () => {
      const customChairs = [
        { id: 'chair-0', xRatio: 0.5, yRatio: 0.2 }, // Directly North
      ];
      const layout = { tableShape: 'oval', tableWidthRatio: 0.5, tableHeightRatio: 0.3, seatCount: 8, customChairs };
      const snapped = calculateTablePerimeterPos(BASE_ROOM_CENTER_X, BASE_ROOM_CENTER_Y, 12, layout);
      expect(snapped.x).toBeCloseTo(BASE_ROOM_CENTER_X, 1);
      expect(snapped.y).toBeCloseTo(BASE_ROOM_CENTER_Y + 0.2 * BASE_ROOM_HEIGHT - BASE_ROOM_CENTER_Y, 1);
    });

    it('scores cameras with perspective and distance bonuses', () => {
      const rearCam = { id: 'cam-rear', role: 'rear', xRatio: 0.5, yRatio: 0.92 };
      const frontCam = { id: 'cam-front', role: 'front', xRatio: 0.5, yRatio: 0.08 };
      const podiumPos = { x: BASE_ROOM_CENTER_X, y: BASE_ROOM_CENTER_Y - 100 };

      // Speaker at Podium (0° azimuth): rear camera faces presenter, front camera is behind them
      const rearScore = scoreCameraCandidate(rearCam, podiumPos, 0);
      const frontScore = scoreCameraCandidate(frontCam, podiumPos, 0);
      expect(rearScore).toBeGreaterThan(frontScore);
    });

    it('resolves standard and wrapping spatial zones', () => {
      const zones = [
        { name: 'Podium', min_angle_deg: -30, max_angle_deg: 30 },
        { name: 'Rear', min_angle_deg: 150, max_angle_deg: -150 }, // Circular wrap across +-180° South
      ];
      expect(resolveSpatialZone(0, zones)?.name).toBe('Podium');
      expect(resolveSpatialZone(160, zones)?.name).toBe('Rear');
      expect(resolveSpatialZone(-160, zones)?.name).toBe('Rear');
      expect(resolveSpatialZone(75, zones)).toBeNull();
    });
  });

  describe('REST Endpoints: GET & PUT /api/v1/devices/:device_id/studio', () => {
    it('retrieves default seeded studio configuration via GET /studio', async () => {
      const res = await fetch(`${baseUrl}/api/v1/devices/1/studio`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.deviceId).toBe(1);
      expect(data.roomLayout).toBeDefined();
      expect(data.roomLayout.tableShape).toBe('oval');
      expect(data.cameras).toHaveLength(3);
      expect(data.liveCamId).toBe('cam-front');
      expect(data.directorConfig).toBeDefined();
      expect(data.directorConfig.holdTimeMs).toBe(1800);
    });

    it('returns 404 for non-existent device on GET /studio', async () => {
      const res = await fetch(`${baseUrl}/api/v1/devices/999/studio`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe('DEVICE_NOT_FOUND');
    });

    it('blocks unauthenticated request to PUT /studio with 401', async () => {
      const res = await fetch(`${baseUrl}/api/v1/devices/1/studio`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomLayout: { tableShape: 'round' } }),
      });
      expect(res.status).toBe(401);
    });

    it('blocks viewer user from modifying studio configuration with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/api/v1/devices/1/studio`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({ roomLayout: { tableShape: 'round' } }),
      });
      expect(res.status).toBe(403);
    });

    it('allows administrator to update studio layout and director settings via PUT /studio', async () => {
      const res = await fetch(`${baseUrl}/api/v1/devices/1/studio`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          roomLayout: {
            tableShape: 'ushape',
            tableWidthRatio: 0.65,
            tableHeightRatio: 0.40,
            seatCount: 12,
            customChairs: [
              { id: 'chair-0', xRatio: 0.2, yRatio: 0.3 },
              { id: 'chair-1', xRatio: 0.8, yRatio: 0.3 },
            ],
          },
          directorConfig: {
            holdTimeMs: 2200,
            hysteresisMarginPercent: 25,
          },
          liveCamId: 'cam-side',
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.roomLayout.tableShape).toBe('ushape');
      expect(data.roomLayout.seatCount).toBe(12);
      expect(data.roomLayout.customChairs).toHaveLength(2);
      expect(data.directorConfig.holdTimeMs).toBe(2200);
      expect(data.directorConfig.hysteresisMarginPercent).toBe(25);
      expect(data.liveCamId).toBe('cam-side');

      // Verify persistence via GET /studio
      const getRes = await fetch(`${baseUrl}/api/v1/devices/1/studio`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.roomLayout.tableShape).toBe('ushape');
      expect(getData.roomLayout.seatCount).toBe(12);
      expect(getData.directorConfig.holdTimeMs).toBe(2200);
      expect(getData.liveCamId).toBe('cam-side');
    });

    it('resets studio configuration to factory defaults when reset: true is passed', async () => {
      const resetRes = await fetch(`${baseUrl}/api/v1/devices/1/studio`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ reset: true }),
      });

      expect(resetRes.status).toBe(200);
      const data = await resetRes.json();
      expect(data.roomLayout.tableShape).toBe('oval');
      expect(data.roomLayout.seatCount).toBe(8);
      expect(data.directorConfig.holdTimeMs).toBe(1800);
      expect(data.liveCamId).toBe('cam-front');
    });
  });

  describe('Authoritative Director Execution on Binary Batch Upload', () => {
    it('evaluates speaker arrivals at Podium and cuts live camera to cam-rear', async () => {
      const baseMs = BigInt(Date.now());
      const records = [
        { offsetMs: 0, angleDeg: 0.0, soundLevelDb: 72.0, confidence: 0.95, slotId: 0 },
        { offsetMs: 50, angleDeg: 0.0, soundLevelDb: 72.0, confidence: 0.95, slotId: 0 },
      ];
      const payload1 = encodeBinaryBatch(baseMs, CLOCK_FLAG_UTC_SYNCHRONIZED, records);

      // First batch: activates track and registers cam-rear as candidate
      const res1 = await fetch(`${baseUrl}/api/v1/measurements`, {
        method: 'POST',
        headers: {
          'x-api-key': 'esp32-acoustic-doa-secret-key-1',
          'Content-Type': 'application/octet-stream',
        },
        body: payload1,
      });
      expect(res1.status).toBe(200);

      // Wait past confirmation threshold (>= 150ms confirmTime)
      await new Promise((resolve) => setTimeout(resolve, 180));

      // Second batch: confirms switch
      const payload2 = encodeBinaryBatch(baseMs + 200n, CLOCK_FLAG_UTC_SYNCHRONIZED, [
        { offsetMs: 200, angleDeg: 0.0, soundLevelDb: 74.0, confidence: 0.95, slotId: 0 },
      ]);
      const res2 = await fetch(`${baseUrl}/api/v1/measurements`, {
        method: 'POST',
        headers: {
          'x-api-key': 'esp32-acoustic-doa-secret-key-1',
          'Content-Type': 'application/octet-stream',
        },
        body: payload2,
      });

      expect(res2.status).toBe(200);
      const data = await res2.json();
      expect(data.active_tracks).toBeGreaterThanOrEqual(1);
      // Rear camera faces presenter at podium (0°) directly
      expect(data.live_cam_id).toBe('cam-rear');

      // Check authoritative studio state
      const studioRes = await fetch(`${baseUrl}/api/v1/devices/1/studio`);
      expect(studioRes.status).toBe(200);
      const studioData = await studioRes.json();
      expect(studioData.liveCamId).toBe('cam-rear');
      const rearCam = studioData.cameras.find((c) => c.id === 'cam-rear');
      expect(rearCam.isLive).toBe(true);
      expect(rearCam.isLockedOnSubject).toBe(true);
    });
  });
});
