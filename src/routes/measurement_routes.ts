import { Router, Request, Response } from 'express';
import { MeasurementService } from '../services/measurement_service.js';

export function createMeasurementRoutes(measurementService: MeasurementService): Router {
  const router = Router();

  /**
   * GET /api/v1/devices/:device_id/measurements/latest
   * Poll latest measurements (REST fallback)
   */
  router.get('/devices/:device_id/measurements/latest', (req: Request, res: Response) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const sinceTimestamp = parseInt(req.query.since_timestamp as string, 10) || 0;
    const limit = parseInt(req.query.limit as string, 10) || 50;

    const records = measurementService.getLatestMeasurements(deviceId, sinceTimestamp, limit);
    const latestTimestamp = records.length > 0 ? records[records.length - 1].timestamp_ms : sinceTimestamp;

    return res.status(200).json({
      device_id: deviceId,
      latest_timestamp_ms: latestTimestamp,
      records,
    });
  });

  /**
   * GET /api/v1/devices/:device_id/measurements
   * Historical query with filtering
   */
  router.get('/devices/:device_id/measurements', (req: Request, res: Response) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const startTime = req.query.start_time ? parseInt(req.query.start_time as string, 10) : undefined;
    const endTime = req.query.end_time ? parseInt(req.query.end_time as string, 10) : undefined;
    const minConfidence = req.query.min_confidence ? parseFloat(req.query.min_confidence as string) : undefined;
    const minSplDb = req.query.min_spl_db ? parseFloat(req.query.min_spl_db as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const result = measurementService.queryMeasurements(deviceId, {
      startTime,
      endTime,
      minConfidence,
      minSplDb,
      limit,
      offset,
    });

    return res.status(200).json(result);
  });

  /**
   * GET /api/v1/devices/:device_id/stats
   * Aggregated acoustic statistics
   */
  router.get('/devices/:device_id/stats', (req: Request, res: Response) => {
    const deviceId = parseInt(req.params.device_id, 10);
    const timeframe = (req.query.timeframe as string) || '1h';

    const stats = measurementService.getStats(deviceId, timeframe);
    return res.status(200).json(stats);
  });

  return router;
}
