import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ROOM_LAYOUT,
  DEFAULT_VIRTUAL_CAMERAS,
  DEFAULT_DIRECTOR_CONFIG,
} from './ptz_director_service.js';
import { isTestEnvironment } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let instance = null;

function requireConfigValue(key, testFallback) {
  const val = process.env[key] ? String(process.env[key]).trim() : '';
  if (val) return val;
  if (isTestEnvironment()) return testFallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

export function insertDefaultCalibration(db, deviceId, now = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO device_calibration (
      device_id, microphone_distance_m, sample_rate, window_size,
      correlation_threshold, sound_level_threshold_db, db_spl_offset,
      angle_offset_deg, adaptive_threshold_enabled, snr_margin_db,
      sector_width_deg, sector_hysteresis_deg, tracker_hold_timeout_ms, updated_at
    ) VALUES (?, 0.082, 44100, 1024, 0.40, 55.0, 96.5, 0.0, 1, 8.0, 15.0, 3.0, 2500, ?)
  `).run(deviceId, now);
}

export function initDatabase(dbPath = process.env.DATABASE_PATH || './app.db') {
  if (instance && instance.open) {
    return instance;
  }

  const db = new Database(dbPath);

  // High performance configuration for fast batch inserts and concurrent SSE reads
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Load and apply schema
  const candidateSchemaPaths = [
    path.resolve(__dirname, '../db/schema.sql'),
    path.resolve(process.cwd(), 'db/schema.sql'),
    path.resolve(__dirname, '../../db/schema.sql'),
  ];
  const schemaPath = candidateSchemaPaths.find((p) => fs.existsSync(p));

  if (schemaPath) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schemaSql);
  } else {
    console.warn('[DB] Warning: db/schema.sql not found; relying on existing database schema.');
  }

  // Idempotent column and index migration for timestamp fusion engine and sector tracker
  try {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='measurements'").get();
    if (tableCheck) {
      const existingCols = db
        .prepare("PRAGMA table_info('measurements')")
        .all()
        .map((c) => c.name);

      if (!existingCols.includes('raw_timestamp_ms')) {
        db.exec('ALTER TABLE measurements ADD COLUMN raw_timestamp_ms INTEGER');
        db.exec('UPDATE measurements SET raw_timestamp_ms = timestamp_ms WHERE raw_timestamp_ms IS NULL');
      }
      if (!existingCols.includes('sync_quality')) {
        db.exec('ALTER TABLE measurements ADD COLUMN sync_quality INTEGER NOT NULL DEFAULT 0');
      }
      if (!existingCols.includes('session_id')) {
        db.exec('ALTER TABLE measurements ADD COLUMN session_id INTEGER');
      }
      if (!existingCols.includes('track_id')) {
        db.exec('ALTER TABLE measurements ADD COLUMN track_id INTEGER');
      }
      if (!existingCols.includes('slot_id')) {
        db.exec('ALTER TABLE measurements ADD COLUMN slot_id INTEGER NOT NULL DEFAULT 0');
      }
      if (!existingCols.includes('sector_id')) {
        db.exec('ALTER TABLE measurements ADD COLUMN sector_id INTEGER NOT NULL DEFAULT 0');
      }
      if (!existingCols.includes('event_type')) {
        db.exec('ALTER TABLE measurements ADD COLUMN event_type INTEGER NOT NULL DEFAULT 1');
      }
      if (!existingCols.includes('active_sources')) {
        db.exec('ALTER TABLE measurements ADD COLUMN active_sources INTEGER NOT NULL DEFAULT 1');
      }
      if (!existingCols.includes('smoothed_angle_deg')) {
        db.exec('ALTER TABLE measurements ADD COLUMN smoothed_angle_deg REAL');
        db.exec('UPDATE measurements SET smoothed_angle_deg = angle_deg WHERE smoothed_angle_deg IS NULL');
      }
      db.exec('DROP INDEX IF EXISTS idx_measurements_device_time');
      db.exec('CREATE INDEX IF NOT EXISTS idx_measurements_device_time ON measurements (device_id, timestamp_ms DESC, id DESC)');
      db.exec('DROP INDEX IF EXISTS idx_measurements_time');
      db.exec('CREATE INDEX IF NOT EXISTS idx_measurements_time ON measurements (timestamp_ms DESC, id DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_measurements_session ON measurements (device_id, session_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_measurements_track ON measurements (device_id, track_id)');
    }

    const calibTableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_calibration'").get();
    if (calibTableCheck) {
      const existingCalibCols = db
        .prepare("PRAGMA table_info('device_calibration')")
        .all()
        .map((c) => c.name);

      if (!existingCalibCols.includes('sector_width_deg')) {
        db.exec('ALTER TABLE device_calibration ADD COLUMN sector_width_deg REAL NOT NULL DEFAULT 15.0');
      }
      if (!existingCalibCols.includes('sector_hysteresis_deg')) {
        db.exec('ALTER TABLE device_calibration ADD COLUMN sector_hysteresis_deg REAL NOT NULL DEFAULT 3.0');
      }
      if (!existingCalibCols.includes('tracker_hold_timeout_ms')) {
        db.exec('ALTER TABLE device_calibration ADD COLUMN tracker_hold_timeout_ms INTEGER NOT NULL DEFAULT 2500');
      }
    }

    // Ensure spatial_zones and device_studio_config tables exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS spatial_zones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        min_angle_deg REAL NOT NULL,
        max_angle_deg REAL NOT NULL,
        color TEXT NOT NULL DEFAULT '#10b981',
        alert_threshold_db REAL DEFAULT 75.0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spatial_zones_device ON spatial_zones (device_id);

      CREATE TABLE IF NOT EXISTS device_studio_config (
        device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
        room_layout_json TEXT NOT NULL,
        cameras_json TEXT NOT NULL,
        director_config_json TEXT NOT NULL,
        live_cam_id TEXT NOT NULL DEFAULT 'cam-front',
        updated_at TEXT NOT NULL
      );
    `);
  } catch (err) {
    console.warn('[DB] Schema migration notice:', err.message);
  }

  // 1. Seed sample device 1 if devices table is empty
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM devices WHERE id = 1');
  const row = countStmt.get();

  if (row.count === 0) {
    const now = new Date().toISOString();
    const defaultApiKey = requireConfigValue('DEFAULT_DEVICE_API_KEY', 'esp32-acoustic-doa-secret-key-1');
    const insertDevice = db.prepare(`
      INSERT INTO devices (id, name, api_key, created_at, last_seen_at, clock_status, firmware_version)
      VALUES (1, 'ESP32 DOA Array #1', ?, ?, ?, 'UNKNOWN', '1.0.0')
    `);

    db.transaction(() => {
      insertDevice.run(defaultApiKey, now, now);
      insertDefaultCalibration(db, 1, now);
    })();

    console.log(`[DB] Seeded initial device 1 (API key: ${defaultApiKey})`);
  }

  // Seed default spatial zones for device 1 if none exist
  try {
    const zoneCount = db.prepare('SELECT COUNT(*) as count FROM spatial_zones WHERE device_id = 1').get().count;
    if (zoneCount === 0) {
      const now = new Date().toISOString();
      const insertZone = db.prepare(`
        INSERT INTO spatial_zones (device_id, name, min_angle_deg, max_angle_deg, color, alert_threshold_db, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(() => {
        insertZone.run(1, 'Podium / Stage', -30.0, 30.0, '#10b981', 75.0, now);
        insertZone.run(1, 'Audience Left', -90.0, -30.0, '#818cf8', 75.0, now);
        insertZone.run(1, 'Audience Right', 30.0, 90.0, '#38bdf8', 75.0, now);
        insertZone.run(1, 'Rear Gallery', 150.0, 180.0, '#f59e0b', 75.0, now);
      })();
      console.log('[DB] Seeded initial spatial zones for device 1');
    }
  } catch (err) {
    console.warn('[DB] Spatial zones seeding check skipped:', err.message);
  }

  // Seed default studio config for device 1 if none exists
  try {
    const studioCount = db.prepare('SELECT COUNT(*) as count FROM device_studio_config WHERE device_id = 1').get().count;
    if (studioCount === 0) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO device_studio_config (
          device_id, room_layout_json, cameras_json, director_config_json, live_cam_id, updated_at
        ) VALUES (1, ?, ?, ?, 'cam-front', ?)
      `).run(
        JSON.stringify(DEFAULT_ROOM_LAYOUT),
        JSON.stringify(DEFAULT_VIRTUAL_CAMERAS),
        JSON.stringify(DEFAULT_DIRECTOR_CONFIG),
        now
      );
      console.log('[DB] Seeded initial studio configuration for device 1');
    }
  } catch (err) {
    console.warn('[DB] Studio config seeding check skipped:', err.message);
  }

  // 2. Seed default admin and viewer accounts from env/config if missing
  const bcryptRounds = isTestEnvironment() ? 10 : 12;
  const insertUser = db.prepare(`
    INSERT INTO users (username, email, password_hash, role, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `);
  const countByRoleStmt = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?');
  const findUserStmt = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?');

  const defaultAccounts = [
    { role: 'admin', label: 'administrator', prefix: 'DEFAULT_ADMIN', userFb: 'admin', emailFb: 'admin@acoustic-doa.local', passFb: 'admin123' },
    { role: 'viewer', label: 'viewer', prefix: 'DEFAULT_VIEWER', userFb: 'viewer', emailFb: 'viewer@acoustic-doa.local', passFb: 'viewer123' },
  ];

  for (const acct of defaultAccounts) {
    if (countByRoleStmt.get(acct.role).count > 0) continue;
    const username = requireConfigValue(`${acct.prefix}_USER`, acct.userFb).toLowerCase();
    const email = requireConfigValue(`${acct.prefix}_EMAIL`, acct.emailFb).toLowerCase();
    const password = requireConfigValue(`${acct.prefix}_PASSWORD`, acct.passFb);
    if (!findUserStmt.get(username, email)) {
      const hash = bcrypt.hashSync(password, bcryptRounds);
      insertUser.run(username, email, hash, acct.role, new Date().toISOString());
      console.log(`[DB] Seeded initial ${acct.label}: ${username} (role: ${acct.role})`);
    }
  }

  instance = db;
  return db;
}
