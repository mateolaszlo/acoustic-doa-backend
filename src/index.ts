import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

// Auto-load .env file if available (Node 20.12+)
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // .env file is optional
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = parseInt(process.env.PORT_HTTP || process.env.HTTP_PORT || '3000', 10);
const HTTPS_PORT = parseInt(process.env.PORT_HTTPS || process.env.HTTPS_PORT || '3443', 10);
const DB_PATH = process.env.DATABASE_PATH || process.env.DB_PATH || './acoustic_doa.db';

const app = createApp(DB_PATH);

// 1. Start HTTP Server (Used by ESP32 embedded nodes to eliminate TLS crypto overhead)
const httpServer = http.createServer(app);

httpServer.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[FATAL] HTTP Port ${HTTP_PORT} is already in use by another application!`);
    console.error(`[HINT] Check for port conflicts (e.g., VS Code forwarded ports, Grafana, Docker).`);
    console.error(`[HINT] You can change the port in .env (e.g. PORT_HTTP=3001)\n`);
    process.exit(1);
  }
  throw err;
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Device Ingestion Gateway listening on http://0.0.0.0:${HTTP_PORT}`);
  console.log(`[HTTP] Swagger Docs available at http://localhost:${HTTP_PORT}/api/docs`);
});

// 2. Start HTTPS Server (Used by Web Visualizer and management clients)
const certKeyPath = path.resolve(__dirname, '../certs/server.key');
const certCrtPath = path.resolve(__dirname, '../certs/server.cert');

if (fs.existsSync(certKeyPath) && fs.existsSync(certCrtPath)) {
  const httpsOptions = {
    key: fs.readFileSync(certKeyPath),
    cert: fs.readFileSync(certCrtPath),
  };

  const httpsServer = https.createServer(httpsOptions, app);

  httpsServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[FATAL] HTTPS Port ${HTTPS_PORT} is already in use! Change PORT_HTTPS in .env.\n`);
      process.exit(1);
    }
    throw err;
  });

  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`[HTTPS] Secure Client Gateway listening on https://0.0.0.0:${HTTPS_PORT}`);
    console.log(`[HTTPS] Real-time SSE stream available at https://localhost:${HTTPS_PORT}/api/v1/devices/1/stream`);
  });
} else {
  console.log('[HTTPS] No TLS certificates found in certs/; running in HTTP-only mode.');
}
