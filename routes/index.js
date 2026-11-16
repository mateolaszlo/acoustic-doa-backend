import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { sseBroadcaster } from '../utils/sse_broadcaster.js';

export function createIndexRoutes(deviceService, dashboardDistPath = null) {
  const router = Router();
  const dashboardIndexPath = dashboardDistPath ? path.join(dashboardDistPath, 'index.html') : null;

  function renderStatusPage(res) {
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
  }

  /**
   * GET /
   * Serve built React Dashboard if available, otherwise fall back to Gateway Status page
   */
  router.get('/', (req, res) => {
    if (req.query.view !== 'status' && dashboardIndexPath && fs.existsSync(dashboardIndexPath)) {
      return res.sendFile(dashboardIndexPath);
    }
    return renderStatusPage(res);
  });

  /**
   * GET /status
   * Render server gateway / device status view
   */
  router.get('/status', (_req, res) => renderStatusPage(res));

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
