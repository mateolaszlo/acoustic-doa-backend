import { Router } from 'express';
import { parseBinaryBatch } from '../utils/binary_parser.js';
import { sseBroadcaster } from '../utils/sse_broadcaster.js';
import { sendError, parseDeviceId, handleUnexpectedRouteError } from '../utils/http_errors.js';

function parseOptionalInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function parseOptionalFloat(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function createMeasurementRoutes(
  measurementService,
  deviceService,
  clockFusionService = null,
  multiTargetTracker = null,
  ptzDirectorService = null,
  spatialZoneService = null
) {
  const router = Router();

  /**
   * POST /api/v1/measurements
   * Upload binary batch from ESP32
   */
  router.post('/measurements', (req, res) => {
    let auth;
    try {
      const apiKey = req.headers['x-api-key'] || '';
      auth = deviceService.authenticateDevice(apiKey);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Measurements:Auth', 'AUTH_SERVICE_ERROR');
    }

    if (!auth) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid or missing x-api-key');
    }

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer)) {
      return sendError(
        res,
        400,
        'INVALID_CONTENT_TYPE',
        'Expected binary payload with Content-Type: application/octet-stream'
      );
    }

    let parseResult;
    try {
      parseResult = parseBinaryBatch(buffer);
    } catch (err) {
      console.error('[Measurements] Unexpected binary parser error:', err);
      return sendError(res, 400, 'INVALID_BINARY_PAYLOAD', err?.message || 'Malformed binary payload');
    }

    if (!parseResult.success || !parseResult.batch) {
      return sendError(
        res,
        parseResult.statusCode || 400,
        'INVALID_BINARY_PAYLOAD',
        parseResult.error
      );
    }

    const batch = parseResult.batch;
    const deviceId = auth.id;
    let effectiveBatch = batch;

    // 1. Apply smooth timeframe normalization & clock fusion (non-fatal if it faults)
    if (clockFusionService) {
      try {
        const fused = clockFusionService.processBatch(deviceId, batch, Date.now());
        effectiveBatch = {
          header: {
            ...batch.header,
            baseTimestampMs: BigInt(fused.effectiveBaseMs),
          },
          records: fused.records,
        };
      } catch (err) {
        console.error(`[Measurements] Clock fusion error for device ${deviceId} (continuing with raw batch):`, err);
      }
    }

    // 2. Apply temporal multi-target tracking (MTT) (non-fatal if it faults)
    if (multiTargetTracker) {
      try {
        const tracked = multiTargetTracker.processBatch(deviceId, effectiveBatch);
        effectiveBatch = {
          header: effectiveBatch.header,
          records: tracked.records,
          activeTracks: tracked.activeTracks,
        };
      } catch (err) {
        console.error(`[Measurements] Multi-target tracker error for device ${deviceId} (continuing without tracks):`, err);
      }
    }

    // 2b. Apply PTZ Director decision engine across active tracks and acoustic arrivals (non-fatal if it faults)
    if (ptzDirectorService) {
      try {
        const zones = spatialZoneService ? spatialZoneService.getZones(deviceId) : [];
        const directorState = ptzDirectorService.processBatch(
          deviceId,
          effectiveBatch.activeTracks || [],
          effectiveBatch.records || [],
          zones,
          Date.now()
        );
        effectiveBatch.director = directorState;
      } catch (err) {
        console.error(`[Measurements] PTZ Director error for device ${deviceId} (continuing without director state):`, err);
      }
    }

    // 3 & 4. Persist batch to database and update device heartbeat
    try {
      measurementService.insertBatch(deviceId, effectiveBatch);
      deviceService.updateDeviceHeartbeat(deviceId, effectiveBatch.header.clockSource);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Measurements:Persist', 'DATABASE_ERROR');
    }

    // 5. Broadcast to all active SSE subscribers (non-fatal after DB commit)
    try {
      sseBroadcaster.broadcastBatch(deviceId, effectiveBatch);
    } catch (err) {
      console.error(`[Measurements] SSE broadcast error for device ${deviceId}:`, err);
    }

    return res.status(200).json({
      status: 'success',
      accepted: effectiveBatch.records.length,
      device_id: deviceId,
      clock_source: effectiveBatch.header.clockSource,
      received_at: new Date().toISOString(),
      active_tracks: effectiveBatch.activeTracks ? effectiveBatch.activeTracks.length : 0,
      live_cam_id: effectiveBatch.director ? effectiveBatch.director.liveCamId : undefined,
    });
  });

  /**
   * GET /api/v1/devices/:device_id/tracks
   * Retrieve active and coasting tracked sound sources
   */
  router.get('/devices/:device_id/tracks', (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be a positive integer');
    }

    try {
      const tracks = multiTargetTracker
        ? multiTargetTracker.getManager(deviceId).getActiveTracksSnapshot()
        : [];
      return res.status(200).json({
        device_id: deviceId,
        track_count: tracks.length,
        tracks,
      });
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Measurements:Tracks', 'TRACKS_FETCH_FAILED');
    }
  });

  /**
   * GET /api/v1/devices/:device_id/measurements/latest
   * Poll latest measurements (REST fallback)
   */
  router.get('/devices/:device_id/measurements/latest', (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be a positive integer');
    }

    try {
      const sinceTimestamp = parseOptionalInt(req.query.since_timestamp) ?? 0;
      const rawLimit = parseOptionalInt(req.query.limit) ?? 50;
      const limit = Math.max(1, Math.min(1000, rawLimit));

      const records = measurementService.getLatestMeasurements(deviceId, sinceTimestamp, limit);
      const latestTimestamp = records.length > 0 ? records[records.length - 1].timestamp_ms : sinceTimestamp;

      return res.status(200).json({
        device_id: deviceId,
        latest_timestamp_ms: latestTimestamp,
        records,
      });
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Measurements:Latest', 'DATABASE_ERROR');
    }
  });

  /**
   * GET /api/v1/devices/:device_id/measurements
   * Historical query with filtering
   */
  router.get('/devices/:device_id/measurements', (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be a positive integer');
    }

    try {
      const startTime = parseOptionalInt(req.query.start_time);
      const endTime = parseOptionalInt(req.query.end_time);
      const minConfidence = parseOptionalFloat(req.query.min_confidence);
      const minSplDb = parseOptionalFloat(req.query.min_spl_db);
      const rawLimit = parseOptionalInt(req.query.limit) ?? 100;
      const rawOffset = parseOptionalInt(req.query.offset) ?? 0;

      const result = measurementService.queryMeasurements(deviceId, {
        startTime,
        endTime,
        minConfidence,
        minSplDb,
        limit: Math.max(1, Math.min(1000, rawLimit)),
        offset: Math.max(0, rawOffset),
      });

      return res.status(200).json(result);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Measurements:Query', 'DATABASE_ERROR');
    }
  });

  /**
   * GET /api/v1/devices/:device_id/count
   * Global all-time measurement count for a device
   */
  router.get('/devices/:device_id/count', (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be a positive integer');
    }

    try {
      const total = measurementService.getTotalCount(deviceId);
      return res.status(200).json({ device_id: deviceId, total });
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Measurements:Count', 'DATABASE_ERROR');
    }
  });

  /**
   * GET /api/v1/devices/:device_id/stats
   * Aggregated acoustic statistics (36 angular bins)
   */
  router.get('/devices/:device_id/stats', (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be a positive integer');
    }

    try {
      const timeframe = req.query.timeframe || '1h';
      const sinceMs = parseOptionalInt(req.query.since_ms) ?? null;

      const stats = measurementService.getStats(deviceId, timeframe, sinceMs);
      return res.status(200).json(stats);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Measurements:Stats', 'DATABASE_ERROR');
    }
  });

  return router;
}

export default createMeasurementRoutes;
