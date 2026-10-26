# Acoustic DOA REST & SSE API Specification

Complete human-readable contract for the Acoustic Direction of Arrival IoT platform.

---

## 1. Architectural Overview & Base URLs

The backend server exposes two network interfaces:
- **Device HTTP Gateway:** `http://<server-ip>:3000/api/v1`  
  Used by ESP32 embedded nodes on the local LAN. Provides lightweight HTTP communication with `x-api-key` authentication to avoid micro-controller TLS crypto latency.
- **Web & Management HTTPS Gateway:** `https://<server-ip>:3443/api/v1`  
  Used by the browser dashboard, external integrators, and management tools. Provides TLS 1.3 encryption, CORS enforcement, and security headers.

---

## 2. Authentication & Error Handling

### Device Requests
Every device request must include the secret API key in the header:
```http
x-api-key: esp32-acoustic-doa-secret-key-1
```

### Standard Error Response Format
All errors return a consistent structured JSON envelope:
```json
{
  "error": {
    "code": "INVALID_BATCH_SIZE",
    "message": "Expected 172 bytes for count 8, received 160 bytes",
    "status": 400,
    "details": null
  }
}
```

Standard status codes:
- `200 OK`: Request succeeded.
- `400 Bad Request`: Validation failure, malformed binary buffer, or out-of-range parameters.
- `401 Unauthorized`: Missing or invalid `x-api-key`.
- `404 Not Found`: Unknown device ID or non-existent route.
- `500 Internal Server Error`: Unhandled server exception.

---

## 3. Hardware Ingestion Endpoints

### 3.1 Device Calibration & Clock Sync
- **Method & Route:** `GET /devices/{device_id}/calibration`
- **Caller:** ESP32 Firmware (called on boot and every 60s)
- **Headers:** `x-api-key: <key>`, `Accept: application/json`
- **Response `200 OK`:**
  ```json
  {
    "device_id": 1,
    "microphone_distance_m": 0.082,
    "sample_rate": 44100,
    "window_size": 1024,
    "correlation_threshold": 0.40,
    "sound_level_threshold_db": 55.0,
    "db_spl_offset": 96.5,
    "angle_offset_deg": 0.0,
    "adaptive_threshold_enabled": true,
    "snr_margin_db": 8.0,
    "server_time_unix_ms": 1791830000123
  }
  ```

---

### 3.2 Binary Measurement Upload
- **Method & Route:** `POST /measurements`
- **Caller:** ESP32 Firmware (sent up to 5 Hz)
- **Headers:**
  - `x-api-key: <key>`
  - `Content-Type: application/octet-stream`
- **Request Body:** Binary Little-Endian payload: 12-byte header + $N \times 20$ bytes records ($1 \le N \le 24$).
- **Response `200 OK`:**
  ```json
  {
    "status": "success",
    "accepted": 12,
    "device_id": 1,
    "clock_source": "SNTP_UTC",
    "received_at": "2026-10-26T17:45:00.120Z"
  }
  ```

---

## 4. Web Dashboard & Management Endpoints

### 4.1 Real-Time Server-Sent Events (SSE) Stream
- **Method & Route:** `GET /devices/{device_id}/stream`
- **Headers:** `Accept: text/event-stream`
- **Description:** Live push stream delivering acoustic detection frames to the browser canvas radar.
- **SSE Stream Protocol:**
  ```http
  HTTP/1.1 200 OK
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive

  event: measurement_batch
  data: {"device_id":1,"clock_flags":1,"base_timestamp_ms":1791830000100,"records":[{"timestamp_ms":1791830000125,"angle_deg":42.5,"delay_us":82.1,"sound_level_db":68.4,"confidence":0.88}]}

  event: heartbeat
  data: {"server_time_unix_ms":1791830015000}
  ```

---

### 4.2 Poll Latest Measurements (REST Fallback)
- **Method & Route:** `GET /devices/{device_id}/measurements/latest`
- **Query Params:**
  - `since_timestamp`: Millisecond Unix timestamp. Only returns measurements strictly newer than this value.
  - `limit`: Maximum records to return (default: 50).
- **Response `200 OK`:**
  ```json
  {
    "device_id": 1,
    "latest_timestamp_ms": 1791830000125,
    "records": [
      {
        "timestamp_ms": 1791830000125,
        "angle_deg": 42.5,
        "delay_us": 82.1,
        "sound_level_db": 68.4,
        "confidence": 0.88
      }
    ]
  }
  ```

---

### 4.3 Query Historical Measurements
- **Method & Route:** `GET /devices/{device_id}/measurements`
- **Query Params:** `start_time`, `end_time`, `min_confidence`, `min_spl_db`, `limit`, `offset`.
- **Response `200 OK`:**
  ```json
  {
    "total": 1420,
    "limit": 50,
    "offset": 0,
    "records": [ ... ]
  }
  ```

---

### 4.4 Get & Update Device Configuration
- **Method & Route:** `GET /devices/{device_id}/config`
- **Method & Route:** `PUT /devices/{device_id}/config`
- **Request Body (PUT):**
  ```json
  {
    "microphone_distance_m": 0.082,
    "sample_rate": 44100,
    "correlation_threshold": 0.45,
    "sound_level_threshold_db": 56.0,
    "db_spl_offset": 100.0,
    "angle_offset_deg": 3.5,
    "adaptive_threshold_enabled": true,
    "snr_margin_db": 9.0
  }
  ```

---

### 4.5 Trigger Zero-Angle Calibration
- **Method & Route:** `POST /devices/{device_id}/calibrate/zero-angle`
- **Request Body:** `{ "sample_count": 20 }`
- **Description:** Computes the circular mean azimuth of the last 20 detections and sets `angle_offset_deg` so that the primary sound source centers at $0^\circ$.
- **Response `200 OK`:**
  ```json
  {
    "device_id": 1,
    "previous_offset_deg": 0.0,
    "new_offset_deg": -14.2,
    "sampled_records": 20
  }
  ```

---

### 4.6 Get Acoustic Aggregation Statistics
- **Method & Route:** `GET /devices/{device_id}/stats?timeframe=1h`
- **Response `200 OK`:**
  ```json
  {
    "device_id": 1,
    "timeframe": "1h",
    "event_count": 342,
    "avg_spl_db": 64.2,
    "peak_spl_db": 88.5,
    "angular_bins_36": [
      12, 5, 2, 0, 0, 1, 4, 18, 54, 82, 35, 12, ...
    ]
  }
  ```
