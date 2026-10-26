import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
const DB_PATH = process.env.DB_PATH || './acoustic_doa.db';

const app = createApp(DB_PATH);

// 1. Start HTTP Server (Used by ESP32 embedded nodes to eliminate TLS crypto overhead)
const httpServer = http.createServer(app);
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
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`[HTTPS] Secure Client Gateway listening on https://0.0.0.0:${HTTPS_PORT}`);
    console.log(`[HTTPS] Real-time SSE stream available at https://localhost:${HTTPS_PORT}/api/v1/devices/1/stream`);
  });
} else {
  console.log('[HTTPS] No TLS certificates found in certs/; running in HTTP-only mode.');
}
