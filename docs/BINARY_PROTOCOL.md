# Binary REST Protocol Specification (POST /api/v1/measurements)

This document provides the byte-level contract implemented by the ESP32 acoustic DOA firmware (`src/network/rest_protocol.h`) and decoded by the backend.

---

## 1. Overview & Transport
- **Endpoint:** `POST /api/v1/measurements`
- **Content-Type:** `application/octet-stream`
- **Transfer Encoding:** Little-Endian for all integers and IEEE-754 binary32 floats
- **Batch Cadence:** Up to 5 requests per second (200 ms minimum interval)
- **Record Batching:** 1 to 24 records per payload ($1 \le N \le 24$)
- **Total Payload Size:** Strictly $12 + (N \times 20)$ bytes:
  - Minimum payload ($N = 1$): 32 bytes
  - Standard payload ($N = 8$): 172 bytes
  - Maximum payload ($N = 24$): 492 bytes

---

## 2. Header Structure (12 Bytes)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Format Version| Record Count  |          Clock Flags          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                    Base Timestamp (64-bit ms)                 +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Offset (Bytes) | Size | Name | Type | Description |
|:---:|:---:|:---|:---:|:---|
| `0` | 1 | `format_version` | `uint8` | Fixed format identifier. Current version is `1`. Other versions must be rejected with HTTP 400. |
| `1` | 1 | `measurement_count` | `uint8` | Number of records $N$ in the packet ($1 \le N \le 24$). Payload length must strictly equal $12 + 20N$. |
| `2 - 3` | 2 | `clock_flags` | `uint16_le` | Synchronization status bitmask (see section 4). |
| `4 - 11` | 8 | `base_timestamp_ms` | `uint64_le` | Base timestamp in milliseconds. |

---

## 3. Record Structure (20 Bytes per Record)

Each of the $N$ records in the batch is packed contiguously:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Offset (32-bit ms)                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     Angle (float32 degrees)                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     Delay (float32 microsec)                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  Sound Level (float32 dB SPL)                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   Confidence (float32 [0..1])                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Offset (Rel) | Size | Name | Type | Unit / Range | Description |
|:---:|:---:|:---|:---:|:---|:---|
| `+0` | 4 | `offset_ms` | `uint32_le` | Milliseconds | Time offset relative to `base_timestamp_ms`. Exact event time = `base_timestamp_ms + offset_ms`. |
| `+4` | 4 | `angle_deg` | `float32_le` | Degrees $[-180.0, +180.0]$ | Azimuth angle $\phi$. $0^\circ = \text{Front}$, $+90^\circ = \text{Right}$, $\pm 180^\circ = \text{Back}$, $-90^\circ = \text{Left}$. |
| `+8` | 4 | `delay_us` | `float32_le` | Microseconds | Equivalent projected X-axis delay $\frac{d \cdot \sin\phi}{c} \times 10^6\text{ }\mu\text{s}$. |
| `+12` | 4 | `sound_level_db` | `float32_le` | dB SPL | Calibrated acoustic SPL level (`rms_db + db_spl_offset`). |
| `+16` | 4 | `confidence` | `float32_le` | Dimensionless $[0.0, 1.0]$ | Weighted least-squares correlation confidence score across the 6 microphone pairs. |

---

## 4. Clock Synchronization Bitmask

The `clock_flags` 16-bit integer conveys the time quality of the batch:

| Hex Value | Constant | Meaning |
|:---:|:---|:---|
| `0x0001` | `CLOCK_FLAG_UTC_SYNCHRONIZED` | Base timestamp is verified UTC calendar time synchronized via on-chip SNTP network client. |
| `0x0002` / `0x0003` | `CLOCK_FLAG_SERVER_SYNCHRONIZED` | Base timestamp is UTC time estimated from the API server's calibration response (`server_time_unix_ms`). |
| `0x0004` | `CLOCK_FLAG_MONOTONIC_UPTIME` | NTP/Server time is unavailable. Base timestamp represents monotonic device uptime since boot in milliseconds. |

---

## 5. Backend Validation Rules

The backend decoder validates each incoming binary packet against the following criteria:
1. `buffer.length >= 12` (must contain at least the full header).
2. `format_version == 1`.
3. `1 <= measurement_count <= 24`.
4. `buffer.length == 12 + (measurement_count * 20)` (exact size match).
5. For each record $i \in [0, N-1]$:
   - `angle_deg` is finite and $-180.0 \le \phi \le 180.0$.
   - `delay_us` is finite.
   - `sound_level_db` is finite and $-200.0 \le \text{SPL} \le 200.0$.
   - `confidence` is finite and $0.0 \le c \le 1.0$.

If any validation check fails, the backend immediately responds with **HTTP 400 Bad Request** and a descriptive JSON error.
