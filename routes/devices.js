import { Router } from 'express';
import { sseBroadcaster } from '../utils/sse_broadcaster.js';
import { sendError, parseDeviceId, handleUnexpectedRouteError } from '../utils/http_errors.js';

export function createDeviceRoutes(
  deviceService,
  calibrationService,
  measurementService,
  authMiddleware,
  clockFusionService = null,
  multiTargetTracker = null,
  spatialZoneService = null,
  ptzDirectorService = null
) {
  const router = Router();
  const adminGuard = authMiddleware
    ? [authMiddleware.authenticateJWT, authMiddleware.requireRole('admin')]
    : [];

  const optionalAuth = authMiddleware?.optionalJWT || ((_req, _res, next) => next());

  function requireDevice(res, rawDeviceId) {
    const deviceId = parseDeviceId(rawDeviceId);
    if (deviceId === null) {
      sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be an integer');
      return null;
    }

    const device = deviceService.getDevice(deviceId);
    if (!device) {
      sendError(res, 404, 'DEVICE_NOT_FOUND', `Device ${deviceId} not found`);
      return null;
    }

    return { deviceId, device };
  }

  /**
   * GET /api/v1/devices
   * List all registered devices (returns full admin details with api_key if authenticated as admin)
   */
  router.get('/devices', optionalAuth, (req, res) => {
    try {
      const isAdmin = Boolean(req.user && req.user.role === 'admin');
      const devices = isAdmin
        ? deviceService.listDevicesAdmin()
        : deviceService.listDevices();

      return res.status(200).json(devices);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Devices:List', 'DEVICE_LIST_FAILED');
    }
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
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return sendError(res, 409, 'DUPLICATE_API_KEY', 'A device with that API key already exists');
      }
      if (err?.message?.includes('required')) {
        return sendError(res, 400, 'INVALID_REQUEST', err.message);
      }
      return handleUnexpectedRouteError(res, err, 'Devices:Create', 'INVALID_REQUEST');
    }
  });

  /**
   * PUT /api/v1/devices/:device_id
   * Update node metadata / rename (Admin only)
   */
  router.put('/devices/:device_id', ...adminGuard, (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be an integer');
    }

    try {
      const device = deviceService.updateDevice(deviceId, req.body || {});
      return res.status(200).json(device);
    } catch (err) {
      if (err?.message?.includes('not found')) {
        return sendError(res, 404, 'DEVICE_NOT_FOUND', err.message);
      }
      if (err?.message?.includes('required')) {
        return sendError(res, 400, 'INVALID_REQUEST', err.message);
      }
      return handleUnexpectedRouteError(res, err, 'Devices:Update', 'DEVICE_UPDATE_FAILED');
    }
  });

  /**
   * POST /api/v1/devices/:device_id/api-key/rotate
   * Generate and assign a new API key to the node (Admin only)
   */
  router.post('/devices/:device_id/api-key/rotate', ...adminGuard, (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be an integer');
    }

    try {
      const result = deviceService.rotateApiKey(deviceId);
      return res.status(200).json(result);
    } catch (err) {
      if (err?.message?.includes('not found')) {
        return sendError(res, 404, 'DEVICE_NOT_FOUND', err.message);
      }
      return handleUnexpectedRouteError(res, err, 'Devices:RotateKey', 'ROTATE_KEY_FAILED');
    }
  });

  /**
   * DELETE /api/v1/devices/:device_id
   * Decommission and delete a node (Admin only)
   */
  router.delete('/devices/:device_id', ...adminGuard, (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be an integer');
    }

    try {
      const result = deviceService.deleteDevice(deviceId);
      if (clockFusionService) {
        clockFusionService.resetTracker(deviceId);
      }
      if (multiTargetTracker) {
        multiTargetTracker.resetDevice(deviceId);
      }
      if (ptzDirectorService) {
        ptzDirectorService.resetDevice(deviceId);
      }
      return res.status(200).json(result);
    } catch (err) {
      if (err?.message?.includes('not found')) {
        return sendError(res, 404, 'DEVICE_NOT_FOUND', err.message);
      }
      if (err?.message?.includes('only remaining')) {
        return sendError(res, 400, 'DELETE_FAILED', err.message);
      }
      return handleUnexpectedRouteError(res, err, 'Devices:Delete', 'DELETE_FAILED');
    }
  });

  /**
   * DELETE /api/v1/devices/:device_id/measurements
   * Purge historical measurements for a specific node (Admin only)
   */
  router.delete('/devices/:device_id/measurements', ...adminGuard, (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be an integer');
    }

    if (!measurementService) {
      return sendError(res, 500, 'SERVICE_UNAVAILABLE', 'Measurement service not configured');
    }

    try {
      const result = measurementService.clearDeviceMeasurements(deviceId);
      if (clockFusionService) {
        clockFusionService.resetTracker(deviceId);
      }
      if (multiTargetTracker) {
        multiTargetTracker.resetDevice(deviceId);
      }
      if (ptzDirectorService) {
        ptzDirectorService.resetDevice(deviceId);
      }
      return res.status(200).json({
        success: true,
        device_id: deviceId,
        deleted_records: result.deleted,
        message: `Successfully purged ${result.deleted} measurements for device ${deviceId}`,
      });
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Devices:PurgeMeasurements', 'PURGE_FAILED');
    }
  });

  /**
   * GET /api/v1/devices/:device_id/calibration
   * Polled by ESP32 at boot and periodically (every 60s)
   */
  router.get('/devices/:device_id/calibration', (req, res) => {
    let auth;
    try {
      const apiKey = req.headers['x-api-key'] || '';
      auth = deviceService.authenticateDevice(apiKey);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Devices:CalibrationAuth', 'AUTH_SERVICE_ERROR');
    }

    if (!auth) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid or missing x-api-key');
    }

    const deviceId = parseDeviceId(req.params.device_id);
    if (deviceId === null || deviceId !== auth.id) {
      return sendError(
        res,
        403,
        'FORBIDDEN',
        `API key is not authorized for device ${req.params.device_id}`
      );
    }

    try {
      const calib = calibrationService.getCalibration(deviceId);
      if (!calib) {
        return sendError(res, 404, 'DEVICE_NOT_FOUND', `Calibration profile for device ${deviceId} not found`);
      }

      deviceService.updateDeviceHeartbeat(deviceId, 'SERVER_UTC');
      return res.status(200).json(calib);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Devices:CalibrationFetch', 'CALIBRATION_FETCH_FAILED');
    }
  });

  /**
   * GET /api/v1/devices/:device_id/zones
   * Retrieve spatial zones / acoustic geofences for this device (Public / Viewer / Admin)
   */
  router.get('/devices/:device_id/zones', (req, res) => {
    try {
      const resolved = requireDevice(res, req.params.device_id);
      if (!resolved) return;

      if (!spatialZoneService) {
        return res.status(200).json([]);
      }

      const zones = spatialZoneService.getZones(resolved.deviceId);
      return res.status(200).json(zones);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Devices:GetZones', 'ZONES_FETCH_FAILED');
    }
  });

  /**
   * PUT /api/v1/devices/:device_id/zones
   * Configure spatial zones for this device (Admin only)
   */
  router.put('/devices/:device_id/zones', ...adminGuard, (req, res) => {
    try {
      const resolved = requireDevice(res, req.params.device_id);
      if (!resolved) return;

      if (!spatialZoneService) {
        return sendError(res, 500, 'SERVICE_UNAVAILABLE', 'Spatial zone service not configured');
      }

      const zonesPayload = Array.isArray(req.body) ? req.body : (req.body?.zones || []);
      const result = spatialZoneService.updateZones(resolved.deviceId, zonesPayload);
      if (!result.success) {
        return sendError(res, 400, 'INVALID_ZONE_CONFIG', result.error);
      }

      return res.status(200).json({
        success: true,
        device_id: resolved.deviceId,
        zones: result.zones,
      });
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Devices:UpdateZones', 'ZONES_UPDATE_FAILED');
    }
  });

  /**
   * GET /api/v1/devices/:device_id/studio
   * Retrieve conference room layout, virtual cameras, director config, and live telemetry (Public / Viewer / Admin)
   */
  router.get('/devices/:device_id/studio', (req, res) => {
    try {
      const resolved = requireDevice(res, req.params.device_id);
      if (!resolved) return;

      if (!ptzDirectorService) {
        return sendError(res, 500, 'SERVICE_UNAVAILABLE', 'PTZ Director service not configured');
      }

      const studio = ptzDirectorService.getStudioConfig(resolved.deviceId);
      return res.status(200).json(studio);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Devices:GetStudio', 'STUDIO_FETCH_FAILED');
    }
  });

  /**
   * PUT /api/v1/devices/:device_id/studio
   * Configure studio layout, cameras, director tuning, or live camera override (Admin only)
   */
  router.put('/devices/:device_id/studio', ...adminGuard, (req, res) => {
    try {
      const resolved = requireDevice(res, req.params.device_id);
      if (!resolved) return;

      if (!ptzDirectorService) {
        return sendError(res, 500, 'SERVICE_UNAVAILABLE', 'PTZ Director service not configured');
      }

      const updated = ptzDirectorService.updateStudioConfig(resolved.deviceId, req.body || {});

      // Broadcast studio_config SSE event to all connected clients (non-fatal after DB commit)
      try {
        sseBroadcaster.broadcastStudioConfig(resolved.deviceId, updated);
      } catch (sseErr) {
        console.error(`[Devices:PutStudio] Failed to broadcast studio_config:`, sseErr);
      }

      return res.status(200).json({
        success: true,
        ...updated,
      });
    } catch (err) {
      if (err?.code?.startsWith?.('SQLITE_')) {
        return handleUnexpectedRouteError(res, err, 'Devices:PutStudio', 'DATABASE_ERROR');
      }
      return sendError(res, 400, 'INVALID_STUDIO_CONFIG', err?.message || 'Invalid studio configuration');
    }
  });

  return router;
}

export default createDeviceRoutes;
