import { Router } from 'express';
import { sseBroadcaster } from '../utils/sse_broadcaster.js';

export function createIndexRoutes(deviceService) {
  const router = Router();

  /**
   * GET /
   * Render server dashboard / landing page view
   */
  router.get('/', (_req, res) => {
    try {
      const devices = deviceService.listDevices();
      const sseSubscribers = sseBroadcaster.getClientCount();
      res.render('index', {
        title: 'Acoustic DOA Server',
        status: 'online',
        uptime: Math.floor(process.uptime()),
        devices,
        sseSubscribers,
      });
    } catch {
      res.json({
        name: 'Acoustic DOA Server',
        status: 'online',
        uptime: process.uptime(),
        swagger_ui: '/api/docs',
        api_version: 'v1',
      });
    }
  });

  /**
   * GET /health
   * Lightweight healthcheck endpoint
   */
  router.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

export default createIndexRoutes;
