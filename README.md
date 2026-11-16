# Acoustic DOA Backend

REST API, SQLite storage, and Server-Sent Events (SSE) server for ESP32 Direction-of-Arrival (DOA) microphone arrays.

It receives binary detection batches from ESP32 nodes over HTTP, tracks sound sources and camera switching server-side, and streams live updates to the web dashboard over HTTPS.

## Requirements

- Node.js 20+ and npm 10+
- OpenSSL (for generating local HTTPS dev certificates)

## Quick Start

```bash
npm install
cp .env.example .env
bash certs/generate_certs.sh
npm run dev
```

Before starting, edit `.env` and replace the placeholder values (especially `JWT_SECRET`, `DEFAULT_ADMIN_*`, and `DEFAULT_VIEWER_*`). The server validates `.env` at startup and exits if required values are missing or left as placeholders.

Default gateways once running:
- **Device Ingestion (HTTP):** `http://localhost:3000` (used by ESP32 nodes with `x-api-key`)
- **Client & Dashboard API (HTTPS):** `https://localhost:3443` (or your configured `PORT_HTTPS`)
- **Swagger UI:** `https://localhost:3443/api/docs`

> **Windows tip:** If port `3443` fails with `EACCES`, set `PORT_HTTPS=8443` (or `DISABLE_HTTPS=true`) in `.env`.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Run server directly (`node ./bin/www`) |
| `npm run dev` | Run server with `nodemon` auto-reload |
| `npm run simulate` | Send synthetic ESP32 binary batches for local testing |
| `npm test` | Run Vitest suite (`vitest run`) |

## Core Responsibilities

- **Binary Ingestion (`POST /api/v1/measurements`):** Decodes 12-byte header + $N \times 20$-byte records ($1 \le N \le 24$) + CRC32 trailer packets from ESP32 arrays.
- **Clock Fusion & Tracking:** Aligns monotonic/SNTP/server timestamps (`ClockFusionService`), maintains circular Kalman speaker tracks (`MultiTargetTracker`), evaluates spatial room zones (`SpatialZoneService`), and computes PTZ camera switching (`PTZDirectorService`).
- **Authenticated Dashboard APIs & SSE:** Uses `HttpOnly` session cookies (and `Authorization: Bearer`) with `admin` / `viewer` roles and broadcasts telemetry, studio layout, zone, and config changes over `/api/v1/devices/:id/stream`.

## Project Structure

```text
acoustic-doa-backend/
├── bin/www              # HTTP + HTTPS startup and shutdown handlers
├── app.js               # Express app, Helmet/CORS middleware, route wiring
├── routes/              # auth, users, devices, measurements, config, stream, index
├── utils/               # SQLite DB, binary parser, tracker, PTZ director, clock fusion, auth
├── db/schema.sql        # SQLite schema
├── certs/               # Local SAN TLS certificate generator
├── public/openapi.yaml  # OpenAPI 3.1 contract served at /api/docs
├── views/               # EJS status & 404 templates
├── scripts/             # ESP32 synthetic telemetry simulator
└── docs/                # Detailed API & binary protocol specs
```

## Documentation

- [REST & SSE API Specification](docs/API_SPECIFICATION.md)
- [Binary Protocol Specification](docs/BINARY_PROTOCOL.md)
- [OpenAPI 3.1 Spec](public/openapi.yaml)
