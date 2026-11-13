# Acoustic DOA Backend Server

High-performance REST API and Server-Sent Events (SSE) streaming server for the **ESP32 Acoustic Direction of Arrival (DOA)** tracking platform. Built in modern JavaScript (ES Modules) following the standard university course architecture (`express-generator` style: `bin/www`, `app.js`, `routes/`, `utils/`, `views/`, and `public/`).

---

## 🌟 Architecture & Features

- **Standard Course Architecture:** Matches the university course structure (*Vaja 2, 3 in 4*):
  - `bin/www`: Dual-port startup script (HTTP + HTTPS listeners, graceful error handling).
  - `app.js`: Express application configuration, middleware, and route mounting.
  - `routes/`: Modular endpoints (`devices.js`, `measurements.js`, `config.js`, `stream.js`, `index.js`).
  - `utils/`: Database management (`db.js`), binary Little-Endian packet decoder (`binary_parser.js`), input validator, and SSE broadcaster.
  - `views/`: EJS templates for the web landing status page (`index.ejs`) and error views.
  - `public/`: Static documentation assets and OpenAPI specification (`openapi.yaml`).
- **Dual-Tier Security Architecture:**
  - **HTTP Device Ingestion (Port 3000):** Lightweight HTTP with `x-api-key` authentication for the ESP32 edge node to eliminate TLS handshake latency and crypto memory overhead on the micro-controller.
  - **HTTPS Management & Streaming (Port 3443):** Strict TLS encrypted gateway with CORS protection for the web visualizer dashboard and management clients.
- **Hardware-Compatible Binary Decoder:** Strictly unpacks the Little-Endian 12-byte header + $N \times 20$-byte records ($1 \le N \le 24$) defined in the ESP32 firmware (`src/network/rest_protocol.h`).
- **Server-Sent Events (SSE) Live Stream:** Sub-20ms real-time event push over pure HTTP (`GET /api/v1/devices/:id/stream`) for the 60fps web visualizer radar canvas.
- **SQLite Persistence with WAL Mode:** High concurrency file-based storage using `better-sqlite3`, capable of thousands of writes per second with zero external database daemons.
- **OpenAPI 3.1 & Interactive Swagger UI:** Complete machine-readable contract at `public/openapi.yaml` and interactive browser documentation served at `/api/docs`.
- **Multi-Clock Normalization & Smooth Timeframe Fusion Engine:** Synchronizes mixed timing packets (`MONOTONIC_UPTIME` `0x0004`, `SERVER_UTC` `0x0002`/`0x0003`, and `SNTP_UTC` `0x0001`) into a strictly monotonic timeline using causal lower-envelope boot anchoring, dynamic Cubic Hermite slewing ($\frac{dT}{dt} \ge +0.5\text{ ms/ms}$), simultaneous CLEAN frame preservation, and retroactive SQLite session tightening.
- **Hardware Node & API Key Management:** REST endpoints for administrators to provision new arrays, rotate 32-character API keys, rename nodes, and decommission hardware without modifying files.
- **Safe Historical Data Purge:** Dedicated endpoint to purge stored measurement history per device without dropping active SSE subscribers.
- **Temporal Multi-Target Tracking (MTT):** Circular Kalman filter on $S^1$ ($[-180^\circ, +180^\circ)$) with Global Nearest Neighbor association and speech-aware `ACTIVE` / `COASTING` track states to eliminate transient silence/reverb twitching.
- **Spatial Room Geofencing:** Persistent sector zones (`Podium`, `Main Table`, `Priority`, `Ignore`, `Mute` / `Zone`, including circular wrap-around across $\pm 180^\circ$) evaluated against incoming tracks.
- **Authoritative PTZ Studio Director Engine:** Server-side persistence of conference room layout (table presets, seats, custom draggable chairs, 1–3 virtual PTZ cameras, director tuning) and deterministic live camera switching broadcast over SSE (`measurement_batch` & `studio_config`).
- **Fault Isolation & Error Handling:** Unified error envelopes (`utils/http_errors.js`), strict `:device_id` & JSON validation, and isolated `try/catch` stages in `POST /measurements` so raw batches persist to SQLite even if enrichment stages fail.
- **Role-Based Access Control (RBAC):** JWT authentication distinguishing `admin` (calibration, node provisioning, zones, studio layout, user management, measurement purge) and `viewer` (read-only monitoring).
- **Remote Device Calibration Engine:** Allows web dashboard users to update array distance, zero-angle offsets, SNR margins, SPL thresholds, sector transition widths, and tracker hold timeouts, which are automatically synced to the ESP32 on its next 60s poll.

---

## 🚀 Quick Start

### 1. Requirements
- Node.js 20.x or higher
- npm 10.x or higher

### 2. Installation
```bash
npm install
```

### 3. Generate Dev TLS Certificates (Optional for HTTPS)
```bash
bash certs/generate_certs.sh
```

### 4. Run Server
```bash
# Production mode (runs bin/www directly)
npm start

# Development mode (with nodemon auto-restart on code changes)
npm run dev
```

The server starts two gateways:
- **HTTP Ingestion:** `http://localhost:3000`
- **HTTPS Client Gateway:** `https://localhost:3443`
- **Web Landing Page:** `http://localhost:3000/`
- **Interactive Swagger Documentation:** `http://localhost:3000/api/docs`

### 5. Run Synthetic ESP32 Simulator
To simulate real-time acoustic sound sources moving around the microphone array:
```bash
npm run simulate
```

### 6. Run Test Suite
```bash
npm test
```

---

## 📁 Project Directory Layout

```text
acoustic-doa-backend/
├── bin/
│   └── www                       # Executable server bootstrap (HTTP 3000 + HTTPS 3443, TLS fallback)
├── routes/
│   ├── index.js                  # Landing page & /health check
│   ├── devices.js                # ESP32 calibration poll, node CRUD, zones & studio config
│   ├── measurements.js           # Binary batch ingestion, tracks, stats & historical queries
│   ├── config.js                 # Web dashboard remote array calibration (Admin guarded)
│   ├── stream.js                 # Server-Sent Events (SSE) live telemetry stream
│   ├── auth.js                   # JWT authentication (login, register, me)
│   └── users.js                  # User role management (Admin only)
├── utils/
│   ├── db.js                     # SQLite initialization, WAL pragma & migrations
│   ├── clock_fusion_service.js   # Multi-clock fusion, causal anchoring & Hermite slew
│   ├── multi_target_tracker.js   # Circular Kalman Multi-Target Tracker (MTT) & coasting
│   ├── spatial_zone_service.js   # Spatial geofencing sectors (wrap-around aware)
│   ├── ptz_director_service.js   # Authoritative PTZ Director & 1-3 camera rig service
│   ├── binary_parser.js          # 12B header + 20B record Little-Endian buffer decoder
│   ├── validator.js              # Acoustic parameter bounds validator
│   ├── sse_broadcaster.js        # SSE connection pool, studio_config push & heartbeats
│   ├── device_service.js         # Device authentication & state queries
│   ├── calibration_service.js    # Calibration profiles & zero-angle trim
│   ├── measurement_service.js    # Batch inserts & 36-bin angular statistics
│   ├── auth_service.js           # Password hashing & JWT management
│   ├── auth_middleware.js        # Express middleware for JWT & RBAC guards
│   └── http_errors.js            # Structured AppError, sendError & parseDeviceId helpers
├── views/
│   ├── index.ejs                 # HTML landing page with active device status
│   └── error.ejs                 # Standard error view template
├── public/
│   └── openapi.yaml              # OpenAPI 3.1 specification (synced with openapi.yaml)
├── db/
│   └── schema.sql                # SQL tables for devices, calibration, measurements, zones, studio, users
├── certs/
│   └── generate_certs.sh         # Local TLS certificate generator
├── scripts/
│   └── simulate_esp32.js         # Synthetic ESP32 DOA array batch generator
├── test/
│   ├── api.test.js               # REST & SSE integration tests (Vitest)
│   ├── auth_and_rbac.test.js     # RBAC & authentication unit tests (Vitest)
│   ├── binary_parser.test.js     # Bit-level protocol unit tests (Vitest)
│   ├── clock_fusion.test.js      # Multi-clock fusion & smooth timeframe tests (Vitest)
│   ├── devices_admin.test.js     # Node provisioning & API key management tests (Vitest)
│   ├── error_handling.test.js    # Error envelopes, validation & fault isolation tests (Vitest)
│   ├── multi_target_tracker.test.js # Circular Kalman & track lifecycle tests (Vitest)
│   ├── spatial_zones.test.js     # Spatial geofencing REST & wrap-around tests (Vitest)
│   └── studio_director.test.js   # Studio persistence & PTZ Director tests (Vitest)
├── app.js                        # Express application & middleware setup
├── openapi.yaml                  # OpenAPI 3.1 contract
└── package.json                  # Pure ES Module dependencies
```

---

## 📡 REST API Reference

| Method | Endpoint | Consumer | Auth | Description |
|:---:|:---|:---|:---:|:---|
| `GET` | `/api/v1/devices/:id/calibration` | ESP32 | `x-api-key` | Retrieve DSP parameters and server UTC time |
| `POST` | `/api/v1/measurements` | ESP32 | `x-api-key` | Ingest binary batch ($12 + 20N + 4$ bytes with CRC32) |
| `GET` | `/api/v1/devices/:id/stream` | Web Client | None | Real-time SSE stream (`0` for all devices) |
| `GET` | `/api/v1/devices/:id/tracks` | Web Client | None | Active & coasting multi-target speaker tracks |
| `GET` | `/api/v1/devices/:id/measurements/latest` | Web Client | None | Poll newest records since timestamp |
| `GET` | `/api/v1/devices/:id/measurements` | Web Client | None | Query historical measurements with filters |
| `GET` | `/api/v1/devices/:id/count` | Web Client | None | Retrieve all-time measurement count (`total`) |
| `GET` | `/api/v1/devices/:id/stats` | Web Client | None | Retrieve 36-bin polar histogram and peak SPL |
| `GET` | `/api/v1/devices/:id/config` | Web Client | None | View active device calibration profile |
| `PUT` | `/api/v1/devices/:id/config` | Web Client | Admin JWT | Update calibration parameters remotely |
| `POST` | `/api/v1/devices/:id/calibrate/zero-angle` | Web Client | Admin JWT | Compute and apply circular mean zero-angle trim |
| `GET` | `/api/v1/devices/:id/zones` | Web Client | None | List spatial room geofence sectors |
| `PUT` | `/api/v1/devices/:id/zones` | Web Client | Admin JWT | Atomically replace spatial zones |
| `GET` | `/api/v1/devices/:id/studio` | Web Client | None | Get persisted room layout, 1–3 cameras & PTZ director state |
| `PUT` | `/api/v1/devices/:id/studio` | Web Client | Admin JWT | Update studio layout, cameras (1–3), director tuning or manual cut |
| `GET` | `/api/v1/devices` | Web Client | Optional JWT | List registered devices (Admin sees API keys & counts) |
| `POST` | `/api/v1/devices` | Web Client | Admin JWT | Provision a new hardware node |
| `PUT` | `/api/v1/devices/:id` | Web Client | Admin JWT | Update hardware node details |
| `POST` | `/api/v1/devices/:id/api-key/rotate` | Web Client | Admin JWT | Rotate device `x-api-key` |
| `DELETE` | `/api/v1/devices/:id` | Web Client | Admin JWT | Decommission device (rejects sole remaining device) |
| `DELETE` | `/api/v1/devices/:id/measurements` | Web Client | Admin JWT | Purge historical measurements without dropping SSE |
| `POST` | `/api/v1/auth/login` | Web Client | None | Authenticate and receive signed JWT |
| `POST` | `/api/v1/auth/register` | Web Client | None | Register new `viewer` account |
| `GET` | `/api/v1/auth/me` | Web Client | JWT | Fetch authenticated user profile |
| `GET` / `PUT` / `DELETE` | `/api/v1/users` / `/:id/role` / `/:id` | Web Client | Admin JWT | List users, update roles, delete users |
| `GET` | `/health` | All | None | Server uptime and health probe |

---

## 📦 Binary Ingestion Format (POST /measurements)

The binary payload consists of a 12-byte header, $N$ contiguous 20-byte records, and terminates with a 4-byte IEEE 802.3 CRC32 trailer (Total: $12 + 20N + 4$ bytes):

### 12-Byte Header (Little-Endian)
- `[0]` `format_version`: uint8 = 1
- `[1]` `measurement_count`: uint8 = 1..24
- `[2..3]` `clock_flags`: uint16_le (`0x0001` SNTP, `0x0002` Server UTC, `0x0004` Monotonic)
- `[4..11]` `base_timestamp_ms`: uint64_le

### 20-Byte Records
- `[+0..+3]` `offset_ms`: uint32_le
- `[+4..+7]` `angle_deg`: float32_le ($\phi \in [-180^\circ, +180^\circ]$)
- `[+8..+11]` `delay_us`: float32_le
- `[+12..+15]` `sound_level_db`: float32_le (calibrated dB SPL)
- `[+16..+19]` `confidence`: float32_le ($[0.0, 1.0]$)

### 4-Byte Trailer (Little-Endian)
- `[12+20N .. 15+20N]` `crc32`: uint32_le (IEEE 802.3 checksum over preceding $12 + 20N$ bytes)

See [`docs/BINARY_PROTOCOL.md`](docs/BINARY_PROTOCOL.md) for complete byte layout specifications.
