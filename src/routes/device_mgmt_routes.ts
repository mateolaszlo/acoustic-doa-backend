import { Router, Request, Response } from 'express';
import { DeviceService } from '../services/device_service.js';

export function createDeviceMgmtRoutes(deviceService: DeviceService): Router {
  const router = Router();

  /**
   * GET /api/v1/devices
   * List all registered devices
   */
  router.get('/devices', (_req: Request, res: Response) => {
    const devices = deviceService.listDevices();
    return res.status(200).json(devices);
  });

  return router;
}
