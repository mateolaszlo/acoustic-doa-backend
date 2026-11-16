import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDatabase } from './utils/db.js';
import { DeviceService } from './utils/device_service.js';
import { CalibrationService } from './utils/calibration_service.js';
import { MeasurementService } from './utils/measurement_service.js';
import { ClockFusionService } from './utils/clock_fusion_service.js';
import { MultiTargetTracker } from './utils/multi_target_tracker.js';
import { SpatialZoneService } from './utils/spatial_zone_service.js';
import { PTZDirectorService } from './utils/ptz_director_service.js';
import { AuthService } from './utils/auth_service.js';
import { createAuthMiddleware } from './utils/auth_middleware.js';

import { createIndexRoutes } from './routes/index.js';
import { createDeviceRoutes } from './routes/devices.js';
import { createMeasurementRoutes } from './routes/measurements.js';
import { createConfigRoutes } from './routes/config.js';
import { createSSERoutes } from './routes/stream.js';
import { createAuthRoutes } from './routes/auth.js';
import { createUserRoutes } from './routes/users.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://localhost:5173',
  'http://127.0.0.1:5173',
  'https://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://localhost:3443',
  'https://127.0.0.1:3443',
  'https://localhost:8443',
  'https://127.0.0.1:8443',
];

function buildCorsOriginValidator() {
  const configured = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const allowlist = new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);

  return (origin, callback) => {
    // Allow same-origin / CLI / curl / ESP32 requests that carry no Origin header
    if (!origin || allowlist.has(origin)) {
      return callback(null, true);
    }
    const err = new Error(`Origin '${origin}' is not allowed by CORS policy`);
    err.status = 403;
    err.code = 'CORS_FORBIDDEN';
    return callback(err, false);
  };
}

export function createApp(dbPath = process.env.DATABASE_PATH || './app.db', options = {}) {
  const app = express();

  // 1. Initialize SQLite Database & Service Layer
  const db = initDatabase(dbPath);
  const deviceService = new DeviceService(db);
  const calibrationService = new CalibrationService(db);
  const measurementService = new MeasurementService(db);
  const clockFusionService = new ClockFusionService(db);
  const multiTargetTracker = new MultiTargetTracker();
  const spatialZoneService = new SpatialZoneService(db);
  const ptzDirectorService = new PTZDirectorService(db);
  const authService = new AuthService(db);
  const authMiddleware = createAuthMiddleware(authService);

  // 2. View Engine Setup (EJS templates matching course standards)
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');

  // 3. Security & Static Middleware
  app.use(
    helmet({
      contentSecurityPolicy: false, // Required for Swagger UI inline scripts
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );
  app.use(cors({ origin: buildCorsOriginValidator(), credentials: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  // 4. Body Parsers
  // Raw octet-stream parser for ESP32 high-speed binary batches (12B header + 20B records)
  app.use(express.raw({ type: 'application/octet-stream', limit: '1mb' }));
  // JSON and URL-encoded parsers for standard REST requests
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // 5. Interactive Swagger UI mounted at /api/docs
  const openApiPath = path.join(__dirname, 'public', 'openapi.yaml');

  if (fs.existsSync(openApiPath)) {
    try {
      const openApiYaml = fs.readFileSync(openApiPath, 'utf-8');
      const openApiSpec = YAML.parse(openApiYaml);
      app.use(
        '/api/docs',
        swaggerUi.serve,
        swaggerUi.setup(openApiSpec, {
          customSiteTitle: 'Acoustic DOA API Explorer',
          swaggerOptions: {
            persistAuthorization: true,
            displayRequestDuration: true,
          },
        })
      );
      console.log(`[API] Swagger documentation mounted at /api/docs`);
    } catch (err) {
      console.warn('[API] Warning: Failed to parse openapi.yaml:', err.message);
    }
  }

  // 6. Mount Root & Healthcheck Routes
  app.use('/', createIndexRoutes(deviceService));

  // 7. Mount API v1 Routers
  const apiRouter = express.Router();

  // Root discovery endpoint for /api/v1
  apiRouter.get('/', (_req, res) => {
    res.status(200).json({
      service: 'Acoustic DOA Tracking & Configuration API',
      version: '1.0.0',
      status: 'online',
      docs_url: '/api/docs',
      servers: [
        { url: '/api/v1', description: 'Current Origin Gateway' },
        { url: 'http://localhost:3000/api/v1', description: 'Local HTTP Gateway (Port 3000)' },
        { url: 'https://localhost:3443/api/v1', description: 'Local HTTPS Secure Gateway (Port 3443)' },
      ],
      endpoints: {
        devices: '/api/v1/devices',
        calibration: '/api/v1/devices/:device_id/calibration',
        measurements: '/api/v1/measurements',
        stream: '/api/v1/devices/:device_id/stream',
        tracks: '/api/v1/devices/:device_id/tracks',
        stats: '/api/v1/devices/:device_id/stats',
        config: '/api/v1/devices/:device_id/config',
        zones: '/api/v1/devices/:device_id/zones',
        studio: '/api/v1/devices/:device_id/studio',
        auth: '/api/v1/auth/login',
        users: '/api/v1/users',
      },
    });
  });

  apiRouter.use(createDeviceRoutes(deviceService, calibrationService, measurementService, authMiddleware, clockFusionService, multiTargetTracker, spatialZoneService, ptzDirectorService));
  apiRouter.use(createMeasurementRoutes(measurementService, deviceService, clockFusionService, multiTargetTracker, ptzDirectorService, spatialZoneService, authMiddleware));
  apiRouter.use(createConfigRoutes(calibrationService, authMiddleware));
  apiRouter.use(createSSERoutes(authMiddleware));
  apiRouter.use('/auth', createAuthRoutes(authService, authMiddleware, options.authRateLimit));
  apiRouter.use('/users', createUserRoutes(authService, authMiddleware));

  app.use('/api/v1', apiRouter);

  // 8. Catch-all 404 Handlers
  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
        status: 404,
      },
    });
  });

  app.use((_req, res) => {
    res.status(404).render('error', {
      message: 'Page Not Found',
      error: { status: 404 },
    });
  });

  // 9. Global Error Handler
  app.use((err, _req, res, _next) => {
    console.error('[Server Error]', err);

    if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: {
          code: 'INVALID_JSON',
          message: err.message || 'Malformed JSON request body',
          status: 400,
        },
      });
    }

    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: err.message || 'Request payload exceeds size limit',
          status: 413,
        },
      });
    }

    const status = err.status || 500;
    const code = err.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR');

    return res.status(status).json({
      error: {
        code,
        message: err.message || 'An unexpected error occurred',
        status,
      },
    });
  });

  return app;
}

export default createApp;
