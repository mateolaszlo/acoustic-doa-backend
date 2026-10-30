import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let instance = null;

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

  // Idempotent column and index migration for timestamp fusion engine
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
      db.exec('DROP INDEX IF EXISTS idx_measurements_device_time');
      db.exec('CREATE INDEX IF NOT EXISTS idx_measurements_device_time ON measurements (device_id, timestamp_ms DESC, id DESC)');
      db.exec('DROP INDEX IF EXISTS idx_measurements_time');
      db.exec('CREATE INDEX IF NOT EXISTS idx_measurements_time ON measurements (timestamp_ms DESC, id DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_measurements_session ON measurements (device_id, session_id)');
    }
  } catch (err) {
    console.warn('[DB] Measurements schema migration notice:', err.message);
  }

  // 1. Seed sample device 1 if devices table is empty
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM devices WHERE id = 1');
  const row = countStmt.get();

  if (row.count === 0) {
    const now = new Date().toISOString();
    const defaultApiKey = process.env.DEFAULT_DEVICE_API_KEY || 'esp32-acoustic-doa-secret-key-1';
    const insertDevice = db.prepare(`
      INSERT INTO devices (id, name, api_key, created_at, last_seen_at, clock_status, firmware_version)
      VALUES (1, 'ESP32 DOA Array #1', ?, ?, ?, 'UNKNOWN', '1.0.0')
    `);
    const insertCalib = db.prepare(`
      INSERT INTO device_calibration (
        device_id, microphone_distance_m, sample_rate, window_size,
        correlation_threshold, sound_level_threshold_db, db_spl_offset,
        angle_offset_deg, adaptive_threshold_enabled, snr_margin_db, updated_at
      ) VALUES (1, 0.082, 44100, 1024, 0.40, 55.0, 96.5, 0.0, 1, 8.0, ?)
    `);

    db.transaction(() => {
      insertDevice.run(defaultApiKey, now, now);
      insertCalib.run(now);
    })();

    console.log(`[DB] Seeded initial device 1 (API key: ${defaultApiKey})`);
  }

  // 2. Seed default admin account if users table is empty
  try {
    const userCountStmt = db.prepare('SELECT COUNT(*) as count FROM users');
    const userRow = userCountStmt.get();
    if (userRow.count === 0) {
      const adminUser = process.env.DEFAULT_ADMIN_USER || 'admin';
      const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@acoustic-doa.local';
      const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
      const hash = bcrypt.hashSync(adminPassword, 10);
      const now = new Date().toISOString();

      const insertUser = db.prepare(`
        INSERT INTO users (username, email, password_hash, role, created_at, last_login_at)
        VALUES (?, ?, ?, 'admin', ?, ?)
      `);
      insertUser.run(adminUser, adminEmail, hash, now, null);
      console.log(`[DB] Seeded initial administrator: ${adminUser} (role: admin)`);
    }
  } catch (err) {
    console.warn('[DB] Users table check skipped:', err.message);
  }

  instance = db;
  return db;
}

export function getDatabase() {
  if (!instance || !instance.open) {
    return initDatabase();
  }
  return instance;
}

export default getDatabase;
