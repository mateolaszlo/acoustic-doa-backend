import { Router } from 'express';
import crypto from 'node:crypto';
import { sseBroadcaster } from '../utils/sse_broadcaster.js';
import { sendError, parseDeviceId, handleUnexpectedRouteError } from '../utils/http_errors.js';

export function createSSERoutes() {
  const router = Router();

  /**
   * GET /api/v1/devices/:device_id/stream
   * Live real-time acoustic event stream via Server-Sent Events
   */
  router.get('/devices/:device_id/stream', (req, res) => {
    const deviceId = parseDeviceId(req.params.device_id, { allowZero: true });
    if (deviceId === null) {
      return sendError(res, 400, 'INVALID_DEVICE_ID', 'Device ID must be a non-negative integer');
    }

    try {
      const clientId = crypto.randomUUID();
      sseBroadcaster.addClient(clientId, deviceId, res);
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'SSE:Stream', 'STREAM_INIT_FAILED');
    }
  });

  return router;
}

export default createSSERoutes;
