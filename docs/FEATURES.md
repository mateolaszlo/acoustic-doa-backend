# Backend Subsystems & Security Features

Reference for server-side signal enrichment, studio automation, security controls, and operational tooling beyond HTTP contracts ([`API_SPECIFICATION.md`](API_SPECIFICATION.md)) and packet framing ([`BINARY_PROTOCOL.md`](BINARY_PROTOCOL.md)).

---

## 1. Multi-Target Tracker (MTT) & Hardware Sector Slots

Implemented in [`utils/multi_target_tracker.js`](../utils/multi_target_tracker.js). Smooths noisy frame-level DOA estimates into stable speaker tracks across display slots `0`, `1`, and `2`.

### Circular Kalman Filter on $S^1$
- **State vector:** $[\theta, \omega]$ where azimuth $\theta$ is geodesically wrapped into $[-180^\circ, +180^\circ)$ via `wrapAngle180()`, preventing wrap discontinuities across the $\pm 180^\circ$ South seam.
- **Adaptive measurement noise:** $R = \sigma_0^2 / \max(0.15, \text{conf})^2$ ($\sigma_0 = 3.5^\circ$), trusting high-correlation detections more heavily.
- **Velocity damping:** Angular velocity $\omega$ is clamped to $[-90, +90]^\circ/\text{s}$, exponentially damped ($\tau = 0.5\,\text{s}$) during prediction, and zeroed (`omega = 0.0`) when `COASTING` across brief speech pauses.

### Dual Operating Modes
1. **Hardware Event Path (`ENTER=1`, `MOVE=2`, `HEARTBEAT=3`, `LEAVE=4`):**
   - Triggered when incoming detections carry firmware `eventType` values (`1..4`).
   - Maps detections directly by firmware `slotId`, confirms `ACTIVE` immediately on `ENTER`/`MOVE`/`HEARTBEAT`, and deletes the track immediately on `LEAVE`.
   - Tracks receiving no events transition to `COASTING` after `3500 ms` of silence and are deleted after `15000 ms`.
2. **Server GNN Kalman Association Path (fallback when firmware events are absent):**
   - Evaluates a 1-to-1 Global Nearest Neighbor cost matrix with hard angular gating (`GATE_MAX_ANGLE_DEG = 25.0°`) and 4-sigma Mahalanobis gating (`GATE_MAHALANOBIS_CHI2 = 16.0`), biasing costs in favor of established `ACTIVE` / `COASTING` tracks.
   - **Lifecycle thresholds:**
     - `TENTATIVE` → `ACTIVE`: requires `>= 2` hits or a single hit with `confidence >= 0.70`; unmatched tentative tracks expire after `TENTATIVE_MAX_AGE_MS = 600 ms`.
     - `ACTIVE` → `COASTING`: after `COASTING_MIN_SILENCE_MS = 150 ms` without detections.
     - `ACTIVE` / `COASTING` → deleted: after `COAST_TIMEOUT_MS = 2500 ms`.
   - Unmatched detections spawn new `TENTATIVE` tracks unless within `15.0°` of an existing track.

---

## 2. Authoritative PTZ Director & Virtual Studio Engine

Implemented in [`utils/ptz_director_service.js`](../utils/ptz_director_service.js). Computes virtual camera pan angles and `ON AIR` camera switching server-side so every connected dashboard receives identical live state.

- **Canonical Coordinate Space:** Operates in `850 × 470` virtual room units (`BASE_ROOM_CENTER_X = 425`, `BASE_ROOM_CENTER_Y = 245`).
- **Shape-Aware Table Projection (`calculateTablePerimeterPos`):**
  - If `customChairs` exist in `roomLayout`, snaps detections within `25°` to the closest chair coordinate.
  - Otherwise projects azimuth onto `round`, `ushape` (podium north zone, left/right desk wings, south base), or `oval` / `hollow_square` ray-box table boundaries.
- **Camera Allocation & Scoring (`scoreCameraCandidate`):**
  - Up to `1..3` cameras (`front`, `rear`, `side` roles; defaults `cam-front`, `cam-rear`, `cam-side`).
  - Ranks candidates by proximity (`0..40` points) plus perspective/facing bonus (`60` points for `rear` on podium `±35°`, `60` points for `front` on audience angles, `+15` side-profile bonus for `60°..140°` cross-table angles).
  - Binds up to 2 simultaneous speakers (`trackSlot` `0` and `1`), with fallback to recent `< 500 ms` detections `>= 50.0` dB (excluding `LEAVE` / `DELETED` / `0`-source rows).
- **Sticky Memory & Resting Return:**
  - Cameras remember `lastTargetPos` across brief pauses and only slew back to `restingPanDeg` after `45000 ms` (`45s`) of room silence.
- **Schmitt-Trigger `ON AIR` Switching:**
  - Prevents camera ping-pong using configurable `holdTimeMs` (default `1800 ms`, range `300..10000`), `confirmTimeMs` (default `350 ms`, range `100..3000`), and `hysteresisMarginPercent` (default `20%`, range `0..100%`).
  - Performs a fast switch (`min(confirmTimeMs, 150) ms`) when the currently live camera is not tracking any active speaker.
  - Supports admin manual `liveCamId` overrides and `{ reset: true }` via `PUT /api/v1/devices/:device_id/studio`.

---

## 3. Spatial Geofencing & Calibration Auto-Trim

### Spatial Zones ([`utils/spatial_zone_service.js`](../utils/spatial_zone_service.js))
- Stores up to `32` named sectors per device with `alert_threshold_db` (`30..130` dB).
- `resolveSpatialZone()` checks standard intervals (`min <= angle <= max`) as well as South-seam wrap-around zones (`min > 0 && max < 0`, matching `angle >= min || angle <= max`).
- `PUT /devices/:id/zones` atomically replaces all zones for a device inside a SQLite transaction and broadcasts `zones_config` over SSE.

### Calibration Validation & Zero-Angle Trim ([`utils/validator.js`](../utils/validator.js), [`utils/calibration_service.js`](../utils/calibration_service.js))
- Enforces firmware-aligned parameter bounds (`sample_rate` in `{44100, 48000}`, `window_size = 1024`, `microphone_distance_m` in `[0.02, 0.11]`, `sector_width_deg` in `[5, 90]`, `sector_hysteresis_deg` in `[0, 15]` and `<= sector_width_deg`, `tracker_hold_timeout_ms` in `[200, 30000]`).
- **`POST /devices/:id/calibrate/zero-angle`:** Reads up to `sample_count` (default `20`, max `1000`) recent measurements with `confidence >= 0.3` (excluding `LEAVE` events), computes the confidence-weighted circular mean:
  $$\bar{\theta} = \operatorname{atan2}\left(\sum c_i \sin\theta_i,\; \sum c_i \cos\theta_i\right)$$
  subtracts $\bar{\theta}$ from `angle_offset_deg` wrapped to `[-180, +180]`, saves it to `device_calibration`, and broadcasts `device_config` over SSE.

---

## 4. Security, Auth, RBAC & Safety Guards

| Mechanism | Module | Behavior |
|---|---|---|
| **Dual Session Auth** | [`utils/auth_middleware.js`](../utils/auth_middleware.js) | Checks `Authorization: Bearer <token>` first, then `acoustic_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` when HTTPS, `24h` maxAge). |
| **Live DB Session Check** | [`utils/auth_middleware.js`](../utils/auth_middleware.js) | Every request verifying a valid `HS256` JWT re-queries `users` by ID so deleted or role-demoted accounts lose privileges immediately. |
| **Sliding-Window Rate Limiter** | [`utils/rate_limiter.js`](../utils/rate_limiter.js) | Protects `POST /auth/login` and `POST /auth/register` (`15 min` window, `AUTH_RATE_LIMIT_MAX || 25` attempts per IP, returns `429` with `Retry-After`). |
| **Constant-Time API Key Check** | [`utils/device_service.js`](../utils/device_service.js) | Validates `x-api-key` using `crypto.timingSafeEqual` and supports `POST /devices/:id/api-key/rotate`. |
| **Privilege & Resource Guards** | [`utils/auth_service.js`](../utils/auth_service.js), [`utils/device_service.js`](../utils/device_service.js) | Blocks deleting/demoting the last remaining `admin` and blocks deleting the last remaining registered `device`. |
| **Fail-Fast Environment Gate** | [`utils/env.js`](../utils/env.js) | Validates ports, `DATABASE_PATH`, `DEFAULT_DEVICE_API_KEY`, default accounts, and rejects short/placeholder `JWT_SECRET` at startup (relaxed only under `VITEST` / `NODE_ENV=test`). |

---

## 5. Developer & Operations Tooling

- **Gateway Status Dashboard (`GET /`) & Healthcheck (`GET /health`):** Server-rendered [`views/index.ejs`](../views/index.ejs) displays uptime, device online/offline states, and active SSE subscriber count.
- **OpenAPI 3.1 / Swagger Explorer (`GET /api/docs`):** Interactive explorer backed by [`public/openapi.yaml`](../public/openapi.yaml).
- **Local TLS Cert Generator ([`certs/generate_certs.sh`](../certs/generate_certs.sh)):** Generates self-signed X.509 certificates with `DNS:localhost,IP:127.0.0.1` SAN extensions (`--force` regenerates).
- **Synthetic ESP32 Simulator (`npm run simulate`):** [`scripts/simulate_esp32.js`](../scripts/simulate_esp32.js) fetches calibration, simulates realistic speech bursts + rotating azimuths, and posts 5 Hz binary batches (`API_HOST`, `PORT_HTTP`, `MAX_BATCHES`, `DEFAULT_DEVICE_API_KEY` env overrides).
