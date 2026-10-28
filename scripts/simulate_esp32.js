/**
 * Synthetic ESP32 Client Simulator
 * Generates realistic acoustic Direction of Arrival (DOA) events and posts
 * binary measurement batches matching src/network/rest_protocol.h at 5 Hz.
 */

import http from 'node:http';
import { encodeBinaryBatch, CLOCK_FLAG_UTC_SYNCHRONIZED } from '../utils/binary_parser.js';

const TARGET_HOST = process.env.API_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.PORT_HTTP || process.env.API_PORT || '3000', 10);
const DEVICE_ID = 1;
const API_KEY = process.env.DEFAULT_DEVICE_API_KEY || process.env.API_KEY || 'esp32-acoustic-doa-secret-key-1';
const BATCH_INTERVAL_MS = 200; // 5 requests per second
const MAX_ITERATIONS = process.env.MAX_BATCHES ? parseInt(process.env.MAX_BATCHES, 10) : 100;

console.log(`[Simulator] Starting ESP32 DOA Simulator against http://${TARGET_HOST}:${TARGET_PORT}`);

// 1. Fetch Calibration Settings
function fetchCalibration() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: TARGET_HOST,
        port: TARGET_PORT,
        path: `/api/v1/devices/${DEVICE_ID}/calibration`,
        method: 'GET',
        headers: {
          'x-api-key': API_KEY,
          Accept: 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(body));
          } else {
            reject(new Error(`Calibration fetch failed: HTTP ${res.statusCode} - ${body}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// 2. Post Binary Measurement Batch
function postBinaryBatch(payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: TARGET_HOST,
        port: TARGET_PORT,
        path: `/api/v1/measurements`,
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'Content-Type': 'application/octet-stream',
          'Content-Length': payload.length,
          Connection: 'keep-alive',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(body));
          } else {
            reject(new Error(`Measurement upload failed: HTTP ${res.statusCode} - ${body}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  try {
    const calib = await fetchCalibration();
    console.log('[Simulator] Received calibration configuration:', calib);

    let angle = 0.0;
    let batchCount = 0;

    const interval = setInterval(async () => {
      try {
        const nowMs = BigInt(Date.now());
        const recordsCount = Math.floor(Math.random() * 4) + 1; // 1 to 4 records per batch
        const records = [];

        for (let i = 0; i < recordsCount; i++) {
          // Slowly rotate simulated sound source around 360 degrees
          angle = (angle + 12.0) % 360.0;
          let wrappedAngle = angle > 180.0 ? angle - 360.0 : angle;

          // Sound level: 55 to 85 dB SPL
          const soundLevel = 58.0 + Math.random() * 25.0;
          const confidence = 0.75 + Math.random() * 0.23;
          const delayUs = (0.082 * Math.sin((wrappedAngle * Math.PI) / 180.0) / 343.0) * 1e6;

          records.push({
            offsetMs: i * 25,
            angleDeg: Number(wrappedAngle.toFixed(1)),
            delayUs: Number(delayUs.toFixed(1)),
            soundLevelDb: Number(soundLevel.toFixed(1)),
            confidence: Number(confidence.toFixed(2)),
          });
        }

        const buffer = encodeBinaryBatch(nowMs, CLOCK_FLAG_UTC_SYNCHRONIZED, records);
        await postBinaryBatch(buffer);
        batchCount++;

        process.stdout.write(
          `\r[Simulator] Uploaded batch #${batchCount}/${MAX_ITERATIONS} (${records.length} records, azimuth: ${records[0].angleDeg.toFixed(1)}°, SPL: ${records[0].soundLevelDb.toFixed(1)} dB)`
        );

        if (batchCount >= MAX_ITERATIONS) {
          clearInterval(interval);
          console.log('\n[Simulator] Simulation completed successfully!');
          process.exit(0);
        }
      } catch (err) {
        console.error('\n[Simulator] Batch upload error:', err.message);
      }
    }, BATCH_INTERVAL_MS);
  } catch (err) {
    console.error('[Simulator] Fatal error:', err.message);
    process.exit(1);
  }
}

run();
