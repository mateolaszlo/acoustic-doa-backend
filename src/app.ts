import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDatabase } from './db/database.js';
import { DeviceService } from './services/device_service.js';
import { CalibrationService } from './services/calibration_service.js';
import { MeasurementService } from './services/measurement_service.js';

import { createDeviceRoutes } from './routes/device_routes.js';
import { createSSERoutes } from './routes/sse_routes.js';
import { createConfigRoutes } from './routes/config_routes.js';
import { createMeasurementRoutes } from './routes/measurement_routes.js';
import { createDeviceMgmtRoutes } from './routes/device_mgmt_routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(dbPath = './acoustic_doa.db'): Express {
  const app = express();

  // Database initialization
  const db = initDatabase(dbPath);
  const deviceService = new DeviceService(db);
  const calibrationService = new CalibrationService(db);
  const measurementService = new MeasurementService(db);

  // Security Middleware
  app.use(
    helmet({
      contentSecurityPolicy: false, // Allows Swagger UI and SSE
    })
  );
  app.use(cors({ origin: true, credentials: true }));

  // Raw body parser for binary octet-stream payloads (ESP32 measurements)
  app.use(express.raw({ type: 'application/octet-stream', limit: '1mb' }));
  // JSON parser for standard REST calls
  app.use(express.json());

  // Mount Swagger UI at /api/docs
  const openApiPath = path.resolve(__dirname, '../openapi.yaml');
  if (fs.existsSync(openApiPath)) {
    const openApiYaml = fs.readFileSync(openApiPath, 'utf-8');
    const openApiSpec = YAML.parse(openApiYaml);
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
    console.log('[API] Swagger documentation mounted at /api/docs');
  }

  // API v1 Router
  const apiRouter = express.Router();
  apiRouter.use(createDeviceRoutes(deviceService, calibrationService, measurementService));
  apiRouter.use(createSSERoutes());
  apiRouter.use(createConfigRoutes(calibrationService));
  apiRouter.use(createMeasurementRoutes(measurementService));
  apiRouter.use(createDeviceMgmtRoutes(deviceService));

  app.use('/api/v1', apiRouter);

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  return app;
}
