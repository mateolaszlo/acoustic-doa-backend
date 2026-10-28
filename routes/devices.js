import { Router } from 'express';

export function createDeviceRoutes(deviceService, calibrationService) {
  const router = Router();

  /**
   * GET /api/v1/devices
   * List all registered devices
   */
  router.get('/devices', (_req, res) => {
    const devices = deviceService.listDevices();
    return res.status(200).json(devices);
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
