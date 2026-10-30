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
- **Role-Based Access Control (RBAC):** JWT authentication distinguishing `admin` (calibration, node provisioning, user management, measurement purge) and `viewer` (read-only monitoring).
- **Remote Device Calibration Engine:** Allows web dashboard users to update array distance, zero-angle offsets, SNR margins, and SPL thresholds, which are automatically synced to the ESP32 on its next 60s poll.

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
│   └── www                       # Executable server bootstrap (HTTP 3000 + HTTPS 3443)
├── routes/
│   ├── index.js                  # Landing page & /health check
│   ├── devices.js                # ESP32 calibration poll, heartbeat & admin node management
│   ├── measurements.js           # Binary batch ingestion & historical queries
│   ├── config.js                 # Web dashboard remote array calibration (Admin guarded)
│   ├── stream.js                 # Server-Sent Events (SSE) live telemetry stream
│   ├── auth.js                   # JWT authentication (login, register, me)
│   └── users.js                  # User role management (Admin only)
├── utils/
│   ├── db.js                     # SQLite initialization, WAL pragma & migrations
│   ├── clock_fusion_service.js   # Multi-clock fusion, causal anchoring & Hermite slew
│   ├── binary_parser.js          # 12B header + 20B record Little-Endian buffer decoder
│   ├── validator.js              # Acoustic parameter bounds validator
│   ├── sse_broadcaster.js        # SSE connection pool & 15s heartbeats
│   ├── device_service.js         # Device authentication & state queries
│   ├── calibration_service.js    # Calibration profiles & zero-angle trim
│   ├── measurement_service.js    # Batch inserts & 36-bin angular statistics
│   ├── auth_service.js           # Password hashing & JWT management
│   └── auth_middleware.js        # Express middleware for JWT & RBAC guards
├── views/
│   ├── index.ejs                 # HTML landing page with active device status
│   └── error.ejs                 # Standard error view template
├── public/
│   └── openapi.yaml              # OpenAPI 3.1 specification & Swagger assets
├── db/
│   └── schema.sql                # SQL tables for devices, calibration, measurements, users
├── certs/
│   └── generate_certs.sh         # Local TLS certificate generator
├── scripts/
│   └── simulate_esp32.js         # Synthetic ESP32 DOA array batch generator
├── test/
│   ├── api.test.js               # REST & SSE integration tests (Vitest)
│   ├── binary_parser.test.js     # Bit-level protocol unit tests (Vitest)
│   ├── clock_fusion.test.js      # Multi-clock fusion & smooth timeframe tests (Vitest)
│   ├── devices_admin.test.js     # Node provisioning & API key management tests (Vitest)
│   └── auth_and_rbac.test.js     # RBAC & authentication unit tests (Vitest)
├── app.js                        # Express application & middleware setup
├── app.db                        # SQLite database file
└── package.json                  # Pure ES Module dependencies
```

---

## 📡 REST API Reference

| Method | Endpoint | Consumer | Auth | Description |
|:---:|:---|:---|:---:|:---|
| `GET` | `/api/v1/devices/:id/calibration` | ESP32 | `x-api-key` | Retrieve DSP parameters and server UTC time |
| `POST` | `/api/v1/measurements` | ESP32 | `x-api-key` | Ingest binary batch ($12 + 20N + 4$ bytes with CRC32) |
| `GET` | `/api/v1/devices/:id/stream` | Web Client | None | Real-time Server-Sent Events (SSE) telemetry stream |
| `GET` | `/api/v1/devices/:id/measurements/latest` | Web Client | None | Poll newest records since timestamp |
| `GET` | `/api/v1/devices/:id/measurements` | Web Client | None | Query historical measurements with filters |
| `GET` | `/api/v1/devices/:id/config` | Web Client | None | View active device calibration profile |
| `PUT` | `/api/v1/devices/:id/config` | Web Client | None | Update calibration parameters remotely |
| `POST` | `/api/v1/devices/:id/calibrate/zero-angle` | Web Client | None | Compute and apply circular mean zero-angle trim |
| `GET` | `/api/v1/devices/:id/stats` | Web Client | None | Retrieve 36-bin polar histogram and peak SPL |
| `GET` | `/api/v1/devices` | Web Client | None | List registered devices and online status |
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
