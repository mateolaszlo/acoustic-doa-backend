import { Router, Request, Response } from 'express';
import { CalibrationService } from '../services/calibration_service.js';

export function createConfigRoutes(calibrationService: CalibrationService): Router {
  const router = Router();

  /**
   * GET /api/v1/devices/:device_id/config
   * Retrieve current configuration
   */
  router.get('/devices/:device_id/config', (req: Request, res: Response) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const calib = calibrationService.getCalibration(deviceId);

    if (!calib) {
      return res.status(404).json({
        error: {
          code: 'DEVICE_NOT_FOUND',
          message: `Device ${deviceId} not found`,
          status: 404,
        },
      });
    }

    return res.status(200).json(calib);
  });

  /**
   * PUT /api/v1/devices/:device_id/config
   * Update calibration parameters
   */
  router.put('/devices/:device_id/config', (req: Request, res: Response) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const result = calibrationService.updateCalibration(deviceId, req.body);

    if (!result.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error,
          status: 400,
        },
      });
    }

    return res.status(200).json(result.data);
  });

  /**
   * POST /api/v1/devices/:device_id/calibrate/zero-angle
   * Trigger zero-angle calibration trim calculation
   */
  router.post('/devices/:device_id/calibrate/zero-angle', (req: Request, res: Response) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const sampleCount = parseInt(req.body?.sample_count, 10) || 20;

    try {
      const result = calibrationService.calibrateZeroAngle(deviceId, sampleCount);
      return res.status(200).json(result);
    } catch (err: any) {
      return res.status(400).json({
        error: {
          code: 'CALIBRATION_FAILED',
          message: err.message,
          status: 400,
        },
      });
    }
  });

  return router;
}
