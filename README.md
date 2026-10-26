# Acoustic DOA Backend Server

High-performance REST API and Server-Sent Events (SSE) streaming server for the **ESP32 Acoustic Direction of Arrival (DOA)** tracking platform.

---

## 🌟 Architecture & Features

- **Dual-Tier Security Architecture:**
  - **HTTP Device Ingestion (Port 3000):** Lightweight HTTP with `x-api-key` authentication for the ESP32 edge node to eliminate TLS handshake latency and crypto memory overhead on the micro-controller.
  - **HTTPS Management & Streaming (Port 3443):** Strict TLS 1.3 encrypted gateway with CORS protection for the web visualizer dashboard and management clients.
- **Hardware-Compatible Binary Decoder:** Strictly unpacks the Little-Endian 12-byte header + $N \times 20$-byte records ($1 \le N \le 24$) defined in the ESP32 firmware (`src/network/rest_protocol.h`).
- **Server-Sent Events (SSE) Live Stream:** Sub-20ms real-time event push over pure HTTP (`GET /api/v1/devices/:id/stream`) for the 60fps web visualizer radar canvas.
- **SQLite Persistence with WAL Mode:** High concurrency file-based storage using `better-sqlite3`, capable of thousands of writes per second with zero external database daemons.
- **OpenAPI 3.1 & Interactive Swagger UI:** Complete machine-readable contract at `openapi.yaml` and interactive browser documentation served at `/api/docs`.
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

### 4. Run Development Server
```bash
npm run dev
```

The server starts two gateways:
- **HTTP Ingestion:** `http://localhost:3000`
- **HTTPS Client Gateway:** `https://localhost:3443`
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

## 📡 REST API Reference

| Method | Endpoint | Consumer | Auth | Description |
|:---:|:---|:---|:---:|:---|
| `GET` | `/api/v1/devices/:id/calibration` | ESP32 | `x-api-key` | Retrieve DSP parameters and server UTC time |
| `POST` | `/api/v1/measurements` | ESP32 | `x-api-key` | Ingest binary batch ($12 + 20N$ bytes) |
| `GET` | `/api/v1/devices/:id/stream` | Web Client | Bearer | Real-time Server-Sent Events (SSE) telemetry stream |
| `GET` | `/api/v1/devices/:id/measurements/latest` | Web Client | Bearer | Poll newest records since timestamp |
| `GET` | `/api/v1/devices/:id/measurements` | Web Client | Bearer | Query historical measurements with filters |
| `GET` | `/api/v1/devices/:id/config` | Web Client | Bearer | View active device calibration profile |
| `PUT` | `/api/v1/devices/:id/config` | Web Client | Bearer | Update calibration parameters remotely |
| `POST` | `/api/v1/devices/:id/calibrate/zero-angle` | Web Client | Bearer | Compute and apply circular mean zero-angle trim |
| `GET` | `/api/v1/devices/:id/stats` | Web Client | Bearer | Retrieve 36-bin polar histogram and peak SPL |
| `GET` | `/api/v1/devices` | Web Client | Bearer | List registered devices and online status |

---

## 📦 Binary Ingestion Format (POST /measurements)

The binary payload consists of a 12-byte header followed by $N$ contiguous 20-byte records:

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

See [`docs/BINARY_PROTOCOL.md`](docs/BINARY_PROTOCOL.md) for complete byte layout specifications.
