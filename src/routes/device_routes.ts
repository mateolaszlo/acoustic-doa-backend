import { Router, Request, Response } from 'express';
import { DeviceService } from '../services/device_service.js';
import { CalibrationService } from '../services/calibration_service.js';
import { MeasurementService } from '../services/measurement_service.js';
import { parseBinaryBatch } from '../protocol/binary_parser.js';
import { sseBroadcaster } from '../services/sse_broadcaster.js';

export function createDeviceRoutes(
  deviceService: DeviceService,
  calibrationService: CalibrationService,
  measurementService: MeasurementService
): Router {
  const router = Router();

  /**
   * GET /api/v1/devices/:device_id/calibration
   * Polled by ESP32 at boot and every 60s
   */
  router.get('/devices/:device_id/calibration', (req: Request, res: Response) => {
    const apiKey = (req.headers['x-api-key'] as string) || '';
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

    const deviceId = parseInt(req.params.device_id, 10);
    if (isNaN(deviceId) || deviceId !== auth.id) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `API key is not authorized for device ${deviceId}`,
          status: 403,
        },
      });
    }

    const calib = calibrationService.getCalibration(deviceId);
    if (!calib) {
      return res.status(404).json({
        error: {
          code: 'DEVICE_NOT_FOUND',
          message: `Calibration profile for device ${deviceId} not found`,
          status: 404,
        },
      });
    }

    // Update heartbeat
    deviceService.updateDeviceHeartbeat(deviceId, 'SERVER_UTC');

    return res.status(200).json(calib);
  });

  /**
   * POST /api/v1/measurements
   * Upload binary batch from ESP32
   */
  router.post('/measurements', (req: Request, res: Response) => {
    const apiKey = (req.headers['x-api-key'] as string) || '';
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

    const buffer = req.body as Buffer;
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

    // 1. Persist batch to database
    measurementService.insertBatch(deviceId, batch);

    // 2. Update device heartbeat
    deviceService.updateDeviceHeartbeat(deviceId, batch.header.clockSource);

    // 3. Broadcast to all active SSE subscribers
    sseBroadcaster.broadcastBatch(deviceId, batch);

    return res.status(200).json({
      status: 'success',
      accepted: batch.records.length,
      device_id: deviceId,
      clock_source: batch.header.clockSource,
      received_at: new Date().toISOString(),
    });
  });

  return router;
}
