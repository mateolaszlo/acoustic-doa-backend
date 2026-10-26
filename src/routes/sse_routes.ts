import { Router, Request, Response } from 'express';
import { sseBroadcaster } from '../services/sse_broadcaster.js';
import crypto from 'node:crypto';

export function createSSERoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/devices/:device_id/stream
   * Live real-time acoustic event stream via Server-Sent Events
   */
  router.get('/devices/:device_id/stream', (req: Request, res: Response) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const clientId = crypto.randomUUID();

    sseBroadcaster.addClient(clientId, isNaN(deviceId) ? 0 : deviceId, res);
  });

  return router;
}
