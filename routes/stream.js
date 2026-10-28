import { Router } from 'express';
import crypto from 'node:crypto';
import { sseBroadcaster } from '../utils/sse_broadcaster.js';

export function createSSERoutes() {
  const router = Router();

  /**
   * GET /api/v1/devices/:device_id/stream
   * Live real-time acoustic event stream via Server-Sent Events
   */
  router.get('/devices/:device_id/stream', (req, res) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const clientId = crypto.randomUUID();

    sseBroadcaster.addClient(clientId, isNaN(deviceId) ? 0 : deviceId, res);
  });

  return router;
}

export default createSSERoutes;
