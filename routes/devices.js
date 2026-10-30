import { Router } from 'express';

export function createDeviceRoutes(
  deviceService,
  calibrationService,
  measurementService,
  authMiddleware,
  clockFusionService = null
) {
  const router = Router();
  const adminGuard = authMiddleware
    ? [authMiddleware.authenticateJWT, authMiddleware.requireRole('admin')]
    : [];

  const optionalAuth = authMiddleware?.optionalJWT || ((_req, _res, next) => next());

  /**
   * GET /api/v1/devices
   * List all registered devices (returns full admin details with api_key if authenticated as admin)
   */
  router.get('/devices', optionalAuth, (req, res) => {
    const isAdmin = Boolean(req.user && req.user.role === 'admin');

    const devices = isAdmin
      ? deviceService.listDevicesAdmin()
      : deviceService.listDevices();

    return res.status(200).json(devices);
  });

  /**
   * POST /api/v1/devices
   * Register a new ESP32 planar array node (Admin only)
   */
  router.post('/devices', ...adminGuard, (req, res) => {
    try {
      const device = deviceService.createDevice(req.body || {});
      return res.status(201).json(device);
    } catch (err) {
      return res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: err.message,
          status: 400,
        },
      });
    }
  });

  /**
   * PUT /api/v1/devices/:device_id
   * Update node metadata / rename (Admin only)
   */
  router.put('/devices/:device_id', ...adminGuard, (req, res) => {
    const deviceId = parseInt(req.params.device_id, 10);
    try {
      const device = deviceService.updateDevice(deviceId, req.body || {});
      return res.status(200).json(device);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      return res.status(status).json({
        error: {
          code: status === 404 ? 'DEVICE_NOT_FOUND' : 'INVALID_REQUEST',
          message: err.message,
          status,
        },
      });
    }
  });

  /**
   * POST /api/v1/devices/:device_id/api-key/rotate
   * Generate and assign a new API key to the node (Admin only)
   */
  router.post('/devices/:device_id/api-key/rotate', ...adminGuard, (req, res) => {
    const deviceId = parseInt(req.params.device_id, 10);
    try {
      const result = deviceService.rotateApiKey(deviceId);
      return res.status(200).json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      return res.status(status).json({
        error: {
          code: status === 404 ? 'DEVICE_NOT_FOUND' : 'ROTATE_KEY_FAILED',
          message: err.message,
          status,
        },
      });
    }
  });

  /**
   * DELETE /api/v1/devices/:device_id
   * Decommission and delete a node (Admin only)
   */
  router.delete('/devices/:device_id', ...adminGuard, (req, res) => {
    const deviceId = parseInt(req.params.device_id, 10);
    try {
      const result = deviceService.deleteDevice(deviceId);
      if (clockFusionService) {
        clockFusionService.resetTracker(deviceId);
      }
      return res.status(200).json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      return res.status(status).json({
        error: {
          code: status === 404 ? 'DEVICE_NOT_FOUND' : 'DELETE_FAILED',
          message: err.message,
          status,
        },
      });
    }
  });

  /**
   * DELETE /api/v1/devices/:device_id/measurements
   * Purge historical measurements for a specific node (Admin only)
   */
  router.delete('/devices/:device_id/measurements', ...adminGuard, (req, res) => {
    const deviceId = parseInt(req.params.device_id, 10);
    if (!measurementService) {
      return res.status(500).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Measurement service not configured',
          status: 500,
        },
      });
    }

    const result = measurementService.clearDeviceMeasurements(deviceId);
    if (clockFusionService) {
      clockFusionService.resetTracker(deviceId);
    }
    return res.status(200).json({
      success: true,
      device_id: deviceId,
      deleted_records: result.deleted,
      message: `Successfully purged ${result.deleted} measurements for device ${deviceId}`,
    });
  });

  /**
   * GET /api/v1/devices/:device_id/calibration
   * Polled by ESP32 at boot and periodically (every 60s)
   */
  router.get('/devices/:device_id/calibration', (req, res) => {
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

  return router;
}

export default createDeviceRoutes;
