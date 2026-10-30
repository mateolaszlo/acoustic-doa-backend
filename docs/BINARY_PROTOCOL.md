# Binary REST Protocol Specification (POST /api/v1/measurements)

This document provides the byte-level contract implemented by the ESP32 acoustic DOA firmware (`src/network/rest_protocol.h`) and decoded by the backend.

---

## 1. Overview & Transport
- **Endpoint:** `POST /api/v1/measurements`
- **Content-Type:** `application/octet-stream`
- **Transfer Encoding:** Little-Endian for all integers, IEEE-754 binary32 floats, and CRC32 trailer
- **Batch Cadence:** Up to 5 requests per second (200 ms minimum interval)
- **Record Batching:** 1 to 24 records per payload ($1 \le N \le 24$)
- **Data Integrity:** 4-byte IEEE 802.3 CRC32 trailer appended after the final record
- **Total Payload Size:** Strictly $12 + (N \times 20) + 4$ bytes:
  - Minimum payload ($N = 1$): **36 bytes** ($12 + 20 + 4$)
  - Standard payload ($N = 8$): **176 bytes** ($12 + 160 + 4$)
  - Maximum payload ($N = 24$): **496 bytes** ($12 + 480 + 4$)

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
| `1` | 1 | `measurement_count` | `uint8` | Number of records $N$ in the packet ($1 \le N \le 24$). Payload length must strictly equal $12 + 20N + 4$. |
| `2 - 3` | 2 | `clock_flags` | `uint16_le` | Synchronization status bitmask (see section 5). |
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

## 4. Trailer Structure: IEEE 802.3 CRC32 (4 Bytes)

Appended immediately following record $N-1$ at offset $12 + (N \times 20)$:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|              IEEE 802.3 CRC32 Checksum (32-bit LE)             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Offset (Bytes) | Size | Name | Type | Description |
|:---:|:---:|:---|:---:|:---|
| $12 + (N \times 20)$ | 4 | `crc32_trailer` | `uint32_le` | IEEE 802.3 CRC32 calculated over all preceding $12 + 20N$ bytes. |

### CRC32 Specification
- **Standard:** IEEE 802.3 (Ethernet / GZIP / PNG)
- **Polynomial:** `0x04C11DB7` (reflected representation: `0xEDB88320`)
- **Initial Remainder:** `0xFFFFFFFF`
- **Final XOR Value:** `0xFFFFFFFF`
- **Test Vector:** The ASCII string `"123456789"` computes to `0xCBF43926`.
- **ESP32 Implementation:** Computed via hardware ROM function `esp_rom_crc32_le`.
- **Node.js Implementation:** Computed via native `node:zlib.crc32(buffer)`.

---

## 5. Clock Synchronization Bitmask

The `clock_flags` 16-bit integer conveys the time quality of the batch:

| Hex Value | Constant | Meaning |
|:---:|:---|:---|
| `0x0001` | `CLOCK_FLAG_UTC_SYNCHRONIZED` | Base timestamp is verified UTC calendar time synchronized via on-chip SNTP network client. |
| `0x0002` / `0x0003` | `CLOCK_FLAG_SERVER_SYNCHRONIZED` | Base timestamp is UTC time estimated from the API server's calibration response (`server_time_unix_ms`). |
| `0x0004` | `CLOCK_FLAG_MONOTONIC_UPTIME` | NTP/Server time is unavailable. Base timestamp represents monotonic device uptime since boot in milliseconds. |

---

## 6. Backend Validation Rules

The backend decoder validates each incoming binary packet against the following criteria:
1. `buffer.length >= 16` (must contain at least 12-byte header + 4-byte CRC trailer).
2. `format_version == 1`.
3. `1 <= measurement_count <= 24`.
4. `buffer.length == 12 + (measurement_count * 20) + 4` (exact size match).
5. Trailer CRC matches calculated IEEE 802.3 CRC32 over the preceding $12 + (N \times 20)$ bytes.
6. For each record $i \in [0, N-1]$:
   - `angle_deg` is finite and $-180.0 \le \phi \le 180.0$.
   - `delay_us` is finite.
   - `sound_level_db` is finite and $-200.0 \le \text{SPL} \le 200.0$.
   - `confidence` is finite and $0.0 \le c \le 1.0$.

If any validation check fails, the backend immediately responds with **HTTP 400 Bad Request** and a descriptive JSON error.

---

## 7. Server-Side Multi-Clock Normalization & Smooth Timeframe Fusion Engine

To ensure that packets from disparate or transitioning timing regimes are merged into a strictly ordered, monotonic chronological timeline in SQLite without teleportation or time-reversal artifacts, the backend processes all batches through `ClockFusionService`:

### 7.1 Timing Regimes & Bitmask Precedence
In accordance with ESP32 firmware bitmask definitions:
1. `CLOCK_FLAG_MONOTONIC_UPTIME` (`0x0004`): Evaluated first. Indicates unsynchronized hardware crystal uptime ($t_{\text{mono}}$ in milliseconds since boot).
2. `CLOCK_FLAG_SERVER_SYNCHRONIZED` (`0x0002` / `0x0003`): Evaluated second. Indicates synchronization derived from the API server's calibration handshake (`0x0001 | 0x0002 = 0x0003`).
3. `CLOCK_FLAG_UTC_SYNCHRONIZED` (`0x0001`): Evaluated third. Pure hardware SNTP discipline from network time servers.

### 7.2 Causal Lower-Envelope Boot Anchoring
For monotonic packets (`0x0004`), server reception time $t_{\text{recv}}$ is anchored against the **batch end** ($t_{\text{batch\_end\_mono}} = t_{\text{base}} + \max_i(\text{offset}_i)$):
$$\hat{T}_{\text{boot\_sample}} = t_{\text{recv}} - t_{\text{batch\_end\_mono}} - \delta_{\text{min\_transit}} \quad (\delta_{\text{min\_transit}} = 2\text{ ms})$$

- **Retroactive Reconciliation:** If a subsequent packet arrives with lower Wi-Fi queueing delay such that $\hat{T}_{\text{boot\_sample}} < \hat{T}_{\text{boot}} - 2\text{ ms}$, earlier rows in SQLite for that boot session are atomically shifted backward to maintain exact hardware delta spacing.
- **Silence Gap Immunity:** When transitioning from Monotonic to UTC, the boot anchor is bounded causally ($\hat{T}_{\text{boot}} \le T_{\text{utc\_start}} - t_{\text{last\_mono\_end}} - 1\text{ ms}$) without bridging across quiet periods, preventing events from teleporting across 10-minute quiet gaps.

### 7.3 Dynamically Scaled Cubic Hermite Slew
When bridging clock source steps (e.g. `SERVER_UTC` $\rightarrow$ `SNTP_UTC` with error $E = T_{\text{new\_raw}} - T_{\text{expected}}$):
- If $E < 0$, the slew window is dynamically scaled:
  $$\tau = \max(2000\text{ ms}, \; 3.0 \cdot |E|)$$
- This mathematically guarantees $\frac{dT_{\text{unified}}}{dt} \ge +0.5\text{ ms/ms} > 0$ across the entire slew, preventing instantaneous time reversals.

### 7.4 Multi-Source (CLEAN) Frame Preservation
Clamping is evaluated at the batch base header level rather than per-record. Simultaneous Primary, Secondary, and Tertiary beam detections from the same 1024-sample FFT frame retain identical unified timestamps and are tie-broken in SQLite by `(timestamp_ms DESC, id DESC)`.

### 7.5 Synchronization Quality Levels
Every stored measurement record is tagged with an integer `sync_quality` flag:
- `0` (`SYNC_QUALITY_MONOTONIC_EST`): Anchored from server receive time during Wi-Fi boot phase.
- `1` (`SYNC_QUALITY_SERVER_SYNCED`): Synchronized via `/api/v1/devices/:id/calibration` HTTP response.
- `2` (`SYNC_QUALITY_SNTP_LOCKED`): Disciplined via hardware SNTP client.
- `3` (`SYNC_QUALITY_HARMONIZED`): Retroactively aligned following subsequent tighter causal bounds or UTC lock.
