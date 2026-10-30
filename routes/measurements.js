import { Router } from 'express';
import { parseBinaryBatch } from '../utils/binary_parser.js';
import { sseBroadcaster } from '../utils/sse_broadcaster.js';

export function createMeasurementRoutes(
  measurementService,
  deviceService,
  clockFusionService = null,
  multiTargetTracker = null
) {
  const router = Router();

  /**
   * POST /api/v1/measurements
   * Upload binary batch from ESP32
   */
  router.post('/measurements', (req, res) => {
    const apiKey = req.headers['x-api-key'] || '';
    const auth = deviceService.authenticateDevice(apiKey);

    if (!auth) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or missing x-api-key',
          status: 401,
        },
      });
    }

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_CONTENT_TYPE',
          message: 'Expected binary payload with Content-Type: application/octet-stream',
          status: 400,
        },
      });
    }

    const parseResult = parseBinaryBatch(buffer);
    if (!parseResult.success || !parseResult.batch) {
      return res.status(parseResult.statusCode || 400).json({
        error: {
          code: 'INVALID_BINARY_PAYLOAD',
          message: parseResult.error,
          status: parseResult.statusCode || 400,
        },
      });
    }

    const batch = parseResult.batch;
    const deviceId = auth.id;

    // 1. Apply smooth timeframe normalization & clock fusion if service is active
    let effectiveBatch = batch;
    if (clockFusionService) {
      const fused = clockFusionService.processBatch(deviceId, batch, Date.now());
      effectiveBatch = {
        header: {
          ...batch.header,
          baseTimestampMs: BigInt(fused.effectiveBaseMs),
        },
        records: fused.records,
      };
    }

    // 2. Apply temporal multi-target tracking (MTT) across unified timeframes
    if (multiTargetTracker) {
      const tracked = multiTargetTracker.processBatch(deviceId, effectiveBatch);
      effectiveBatch = {
        header: effectiveBatch.header,
        records: tracked.records,
        activeTracks: tracked.activeTracks,
      };
    }

    // 3. Persist batch to database
    measurementService.insertBatch(deviceId, effectiveBatch);

    // 4. Update device heartbeat
    deviceService.updateDeviceHeartbeat(deviceId, effectiveBatch.header.clockSource);

    // 5. Broadcast to all active SSE subscribers
    sseBroadcaster.broadcastBatch(deviceId, effectiveBatch);

    return res.status(200).json({
      status: 'success',
      accepted: effectiveBatch.records.length,
      device_id: deviceId,
      clock_source: effectiveBatch.header.clockSource,
      received_at: new Date().toISOString(),
      active_tracks: effectiveBatch.activeTracks ? effectiveBatch.activeTracks.length : 0,
    });
  });

  /**
   * GET /api/v1/devices/:device_id/tracks
   * Retrieve active and coasting tracked sound sources
   */
  router.get('/devices/:device_id/tracks', (req, res) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const tracks = multiTargetTracker
      ? multiTargetTracker.getManager(deviceId).getActiveTracksSnapshot()
      : [];
    return res.status(200).json({
      device_id: deviceId,
      track_count: tracks.length,
      tracks,
    });
  });

  /**
   * GET /api/v1/devices/:device_id/measurements/latest
   * Poll latest measurements (REST fallback)
   */
  router.get('/devices/:device_id/measurements/latest', (req, res) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const sinceTimestamp = parseInt(req.query.since_timestamp, 10) || 0;
    const limit = parseInt(req.query.limit, 10) || 50;

    const records = measurementService.getLatestMeasurements(deviceId, sinceTimestamp, limit);
    const latestTimestamp = records.length > 0 ? records[records.length - 1].timestamp_ms : sinceTimestamp;

    return res.status(200).json({
      device_id: deviceId,
      latest_timestamp_ms: latestTimestamp,
      records,
    });
  });

  /**
   * GET /api/v1/devices/:device_id/measurements
   * Historical query with filtering
   */
  router.get('/devices/:device_id/measurements', (req, res) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const startTime = req.query.start_time ? parseInt(req.query.start_time, 10) : undefined;
    const endTime = req.query.end_time ? parseInt(req.query.end_time, 10) : undefined;
    const minConfidence = req.query.min_confidence ? parseFloat(req.query.min_confidence) : undefined;
    const minSplDb = req.query.min_spl_db ? parseFloat(req.query.min_spl_db) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;

    const result = measurementService.queryMeasurements(deviceId, {
      startTime,
      endTime,
      minConfidence,
      minSplDb,
      limit,
      offset,
    });

    return res.status(200).json(result);
  });

  /**
   * GET /api/v1/devices/:device_id/count
   * Global all-time measurement count for a device
   */
  router.get('/devices/:device_id/count', (req, res) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const total = measurementService.getTotalCount(deviceId);
    return res.status(200).json({ device_id: deviceId, total });
  });

  /**
   * GET /api/v1/devices/:device_id/stats
   * Aggregated acoustic statistics (36 angular bins)
   */
  router.get('/devices/:device_id/stats', (req, res) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const timeframe = req.query.timeframe || '1h';
    const sinceMs = req.query.since_ms ? parseInt(req.query.since_ms, 10) : null;

    const stats = measurementService.getStats(deviceId, timeframe, sinceMs);
    return res.status(200).json(stats);
  });

  return router;
}

export default createMeasurementRoutes;
