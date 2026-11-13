import { Router } from 'express';
import { sendError, parseDeviceId, handleUnexpectedRouteError } from '../utils/http_errors.js';

export function createConfigRoutes(calibrationService, authMiddleware = null) {
  const router = Router();
  const adminGuard = authMiddleware ? [authMiddleware.authenticateJWT, authMiddleware.requireRole('admin')] : [];

  /**
   * GET /api/v1/devices/:device_id/config
   * Retrieve current configuration (Public read-only for radar display)
   */
  router.get('/devices/:device_id/config', (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be a positive integer');
    }

    try {
      const calib = calibrationService.getCalibration(deviceId);
      if (!calib) {
        return sendError(res, 404, 'DEVICE_NOT_FOUND', `Device ${deviceId} not found`);
      }

      return res.status(200).json(calib);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Config:Get', 'CONFIG_FETCH_FAILED');
    }
  });

  /**
   * PUT /api/v1/devices/:device_id/config
   * Update calibration parameters (Requires Admin Role)
   */
  router.put('/devices/:device_id/config', ...adminGuard, (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be a positive integer');
    }

    try {
      const result = calibrationService.updateCalibration(deviceId, req.body || {});
      if (!result.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', result.error);
      }

      return res.status(200).json(result.data);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Config:Update', 'CONFIG_UPDATE_FAILED');
    }
  });

  /**
   * POST /api/v1/devices/:device_id/calibrate/zero-angle
   * Trigger zero-angle calibration trim calculation (Requires Admin Role)
   */
  router.post('/devices/:device_id/calibrate/zero-angle', ...adminGuard, (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be a positive integer');
    }

    const parsedSamples = parseInt(req.body?.sample_count, 10);
    const sampleCount = Number.isFinite(parsedSamples) && parsedSamples > 0 ? Math.min(1000, parsedSamples) : 20;

    try {
      const result = calibrationService.calibrateZeroAngle(deviceId, sampleCount);
      return res.status(200).json(result);
    } catch (err) {
      if (err?.message?.includes('not found')) {
        return sendError(res, 404, 'DEVICE_NOT_FOUND', err.message);
      }
      if (err?.code?.startsWith?.('SQLITE_')) {
        return handleUnexpectedRouteError(res, err, 'Config:CalibrateZero', 'CALIBRATION_FAILED');
      }
      return sendError(res, 400, 'CALIBRATION_FAILED', err?.message || 'Zero-angle calibration failed');
    }
  });

  return router;
}

export default createConfigRoutes;
