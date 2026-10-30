CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  clock_status TEXT DEFAULT 'UNKNOWN',
  firmware_version TEXT DEFAULT '1.0.0'
);

CREATE TABLE IF NOT EXISTS device_calibration (
  device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  microphone_distance_m REAL NOT NULL DEFAULT 0.082,
  sample_rate INTEGER NOT NULL DEFAULT 44100,
  window_size INTEGER NOT NULL DEFAULT 1024,
  correlation_threshold REAL NOT NULL DEFAULT 0.40,
  sound_level_threshold_db REAL NOT NULL DEFAULT 55.0,
  db_spl_offset REAL NOT NULL DEFAULT 96.5,
  angle_offset_deg REAL NOT NULL DEFAULT 0.0,
  adaptive_threshold_enabled INTEGER NOT NULL DEFAULT 1,
  snr_margin_db REAL NOT NULL DEFAULT 8.0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  timestamp_ms INTEGER NOT NULL,
  raw_timestamp_ms INTEGER,
  clock_flags INTEGER NOT NULL,
  sync_quality INTEGER NOT NULL DEFAULT 0,
  session_id INTEGER,
  angle_deg REAL NOT NULL,
  delay_us REAL NOT NULL,
  sound_level_db REAL NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'viewer')),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_measurements_device_time ON measurements (device_id, timestamp_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_measurements_time ON measurements (timestamp_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_measurements_session ON measurements (device_id, session_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
