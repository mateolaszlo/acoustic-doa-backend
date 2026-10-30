import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ClockFusionService,
  SYNC_QUALITY_MONOTONIC_EST,
  SYNC_QUALITY_SERVER_SYNCED,
  SYNC_QUALITY_SNTP_LOCKED,
  SYNC_QUALITY_HARMONIZED,
} from '../utils/clock_fusion_service.js';
import { MeasurementService } from '../utils/measurement_service.js';
import {
  parseBinaryBatch,
  encodeBinaryBatch,
  CLOCK_FLAG_UTC_SYNCHRONIZED,
  CLOCK_FLAG_SERVER_SYNCHRONIZED,
  CLOCK_FLAG_MONOTONIC_UPTIME,
} from '../utils/binary_parser.js';

describe('ClockFusionService & Timeframe Normalization', () => {
  let db;
  let measurementService;
  let clockFusion;

  beforeEach(() => {
    // In-memory test database with full schema
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE devices (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE measurements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        raw_timestamp_ms INTEGER,
        clock_flags INTEGER NOT NULL,
        sync_quality INTEGER NOT NULL DEFAULT 0,
        session_id INTEGER,
        track_id INTEGER,
        smoothed_angle_deg REAL,
        angle_deg REAL NOT NULL,
        delay_us REAL NOT NULL,
        sound_level_db REAL NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_measurements_device_time ON measurements (device_id, timestamp_ms DESC, id DESC);
      CREATE INDEX idx_measurements_time ON measurements (timestamp_ms DESC, id DESC);
      CREATE INDEX idx_measurements_session ON measurements (device_id, session_id);

      INSERT INTO devices (id, name, api_key, created_at) VALUES (1, 'Node #1', 'key-1', '2026-01-01T00:00:00Z');
      INSERT INTO devices (id, name, api_key, created_at) VALUES (2, 'Node #2', 'key-2', '2026-01-01T00:00:00Z');
    `);

    measurementService = new MeasurementService(db);
    clockFusion = new ClockFusionService(db);
  });

  it('1. Bitmask Classification: classifies 0x0001 as SNTP_UTC, 0x0002 & 0x0003 as SERVER_UTC, and 0x0004 as MONOTONIC_UPTIME', () => {
    // 0x0001 (SNTP)
    const bufSntp = encodeBinaryBatch(1720000000000n, CLOCK_FLAG_UTC_SYNCHRONIZED, [
      { offsetMs: 0, angleDeg: 10, delayUs: 0, soundLevelDb: 60, confidence: 0.9 },
    ]);
    const parsedSntp = parseBinaryBatch(bufSntp).batch;
    expect(parsedSntp.header.clockSource).toBe('SNTP_UTC');

    // 0x0002 (Server UTC direct)
    const bufServer2 = encodeBinaryBatch(1720000000000n, CLOCK_FLAG_SERVER_SYNCHRONIZED, [
      { offsetMs: 0, angleDeg: 10, delayUs: 0, soundLevelDb: 60, confidence: 0.9 },
    ]);
    const parsedServer2 = parseBinaryBatch(bufServer2).batch;
    expect(parsedServer2.header.clockSource).toBe('SERVER_UTC');

    // 0x0003 (Firmware server synced: UTC_SYNCHRONIZED | SERVER_SYNCHRONIZED)
    const bufServer3 = encodeBinaryBatch(1720000000000n, 0x0003, [
      { offsetMs: 0, angleDeg: 10, delayUs: 0, soundLevelDb: 60, confidence: 0.9 },
    ]);
    const parsedServer3 = parseBinaryBatch(bufServer3).batch;
    expect(parsedServer3.header.clockSource).toBe('SERVER_UTC');

    // 0x0004 (Monotonic uptime)
    const bufMono = encodeBinaryBatch(5000n, CLOCK_FLAG_MONOTONIC_UPTIME, [
      { offsetMs: 0, angleDeg: 10, delayUs: 0, soundLevelDb: 60, confidence: 0.9 },
    ]);
    const parsedMono = parseBinaryBatch(bufMono).batch;
    expect(parsedMono.header.clockSource).toBe('MONOTONIC_UPTIME');
  });

  it('2. Monotonic Boot Uptime & Batch-End Anchoring: anchors recvTimeMs to batch end and preserves intra-batch offsets', () => {
    const recvTimeMs = 1720000010000;
    const records = [];
    for (let i = 0; i < 24; i++) {
      records.push({
        offsetMs: i * 80, // spans 0 .. 1840 ms
        angleDeg: 15.0,
        delayUs: 0.0,
        soundLevelDb: 65.0,
        confidence: 0.85,
      });
    }

    const rawBatch = {
      header: {
        clockFlags: CLOCK_FLAG_MONOTONIC_UPTIME,
        baseTimestampMs: 10000n,
        clockSource: 'MONOTONIC_UPTIME',
      },
      records,
    };

    const fused = clockFusion.processBatch(1, rawBatch, recvTimeMs);

    expect(fused.syncQuality).toBe(SYNC_QUALITY_MONOTONIC_EST);
    expect(fused.records.length).toBe(24);

    // Newest record (index 23, offset 1840ms) must not exceed recvTimeMs
    const newestRecord = fused.records[23];
    expect(newestRecord.timestampMs).toBeLessThanOrEqual(recvTimeMs);

    // Intra-batch offsets must be exactly preserved (no clamping distortion)
    for (let i = 1; i < 24; i++) {
      const dt = fused.records[i].timestampMs - fused.records[i - 1].timestampMs;
      expect(dt).toBe(80);
    }
  });

  it('3. Pre-Sync Queueing Delay & Retroactive Tightening: shifts delayed monotonic batch when subsequent batch reveals tighter bound', () => {
    // Device boots at t_boot = 1720000000000.
    // Batch 1 (mono 1000..2000 ms) is delayed during Wi-Fi connection by 5000ms.
    // It arrives at server recvTime = 1720000007000 (sample anchor = 1720000007000 - 2000 - 2 = 1720000004998).
    const delayedRecvMs = 1720000007000;
    const batch1 = {
      header: {
        clockFlags: CLOCK_FLAG_MONOTONIC_UPTIME,
        baseTimestampMs: 1000n,
        clockSource: 'MONOTONIC_UPTIME',
      },
      records: [
        { offsetMs: 0, angleDeg: 10, delayUs: 0, soundLevelDb: 60, confidence: 0.9 },
        { offsetMs: 1000, angleDeg: 12, delayUs: 0, soundLevelDb: 61, confidence: 0.9 },
      ],
    };

    const fused1 = clockFusion.processBatch(1, batch1, delayedRecvMs);
    measurementService.insertBatch(1, { header: batch1.header, records: fused1.records });

    const rowsBefore = measurementService.getLatestMeasurements(1, 0, 10);
    expect(rowsBefore.length).toBe(2);

    // Batch 2 (mono 2100..2200 ms) arrives with normal transit delay at recvTime = 1720000002202.
    // sample anchor = 1720000002202 - 2200 - 2 = 1720000000000 (tighter upper bound by ~4998ms!).
    const normalRecvMs = 1720000002202;
    const batch2 = {
      header: {
        clockFlags: CLOCK_FLAG_MONOTONIC_UPTIME,
        baseTimestampMs: 2100n,
        clockSource: 'MONOTONIC_UPTIME',
      },
      records: [
        { offsetMs: 100, angleDeg: 20, delayUs: 0, soundLevelDb: 62, confidence: 0.9 },
      ],
    };

    const fused2 = clockFusion.processBatch(1, batch2, normalRecvMs);
    measurementService.insertBatch(1, { header: batch2.header, records: fused2.records });

    // Verify retroactive back-patching shifted Batch 1 to contiguous timeline with Batch 2
    const allRows = measurementService.getLatestMeasurements(1, 0, 10);
    expect(allRows.length).toBe(3);

    // Records should now be strictly chronological
    expect(allRows[0].timestamp_ms).toBeLessThan(allRows[1].timestamp_ms);
    expect(allRows[1].timestamp_ms).toBeLessThan(allRows[2].timestamp_ms);

    // Batch 1 record 1 (raw 2000ms) and Batch 2 record 0 (raw 2200ms) must be ~200ms apart
    const dt = allRows[2].timestamp_ms - allRows[1].timestamp_ms;
    expect(dt).toBeCloseTo(200, -1);
  });

  it('4. 10-Minute Silence Gap Immunity: monotonic batch is not teleported across long quiet periods when UTC locks', () => {
    const t0 = 1720000000000;
    // Batch 1: Monotonic batch arriving at t0
    const batch1 = {
      header: {
        clockFlags: CLOCK_FLAG_MONOTONIC_UPTIME,
        baseTimestampMs: 5000n,
        clockSource: 'MONOTONIC_UPTIME',
      },
      records: [{ offsetMs: 0, angleDeg: 10, delayUs: 0, soundLevelDb: 60, confidence: 0.9 }],
    };
    const fused1 = clockFusion.processBatch(1, batch1, t0);
    measurementService.insertBatch(1, { header: batch1.header, records: fused1.records });

    const batch1RowBefore = measurementService.getLatestMeasurements(1, 0, 10)[0];
    const originalBatch1Ts = batch1RowBefore.timestamp_ms;

    // 10 minutes (600,000 ms) of complete silence elapsed
    const tSilence = t0 + 600000;

    // Batch 2: SNTP UTC lock arrives 10 minutes later
    const batch2 = {
      header: {
        clockFlags: CLOCK_FLAG_UTC_SYNCHRONIZED,
        baseTimestampMs: BigInt(tSilence),
        clockSource: 'SNTP_UTC',
      },
      records: [{ offsetMs: 0, angleDeg: 30, delayUs: 0, soundLevelDb: 65, confidence: 0.95 }],
    };

    const fused2 = clockFusion.processBatch(1, batch2, tSilence);
    measurementService.insertBatch(1, { header: batch2.header, records: fused2.records });

    const rowsAfter = measurementService.getLatestMeasurements(1, 0, 10);
    expect(rowsAfter.length).toBe(2);

    // Monotonic Batch 1 must NOT be teleported to 10 minutes later; its timestamp must remain close to t0
    expect(rowsAfter[0].timestamp_ms).toBe(originalBatch1Ts);
    expect(rowsAfter[0].sync_quality).toBe(SYNC_QUALITY_HARMONIZED);
    // Batch 2 must be 10 minutes later
    expect(rowsAfter[1].timestamp_ms - rowsAfter[0].timestamp_ms).toBeGreaterThanOrEqual(599000);
  });

  it('5. Simultaneous Multi-Source CLEAN Frame Preservation: identical offsetMs records receive equal timestamps', () => {
    // 3 CLEAN sources from the same 1024-sample FFT frame (Primary, Secondary, Tertiary)
    // followed by a second frame 50ms later
    const batch = {
      header: {
        clockFlags: CLOCK_FLAG_UTC_SYNCHRONIZED,
        baseTimestampMs: 1720000000000n,
        clockSource: 'SNTP_UTC',
      },
      records: [
        { offsetMs: 10, angleDeg: -45.0, delayUs: 10.0, soundLevelDb: 72.0, confidence: 0.95 }, // Primary
        { offsetMs: 10, angleDeg: 60.0, delayUs: 25.0, soundLevelDb: 65.0, confidence: 0.70 }, // Secondary
        { offsetMs: 10, angleDeg: 120.0, delayUs: 40.0, soundLevelDb: 58.0, confidence: 0.50 }, // Tertiary
        { offsetMs: 60, angleDeg: -40.0, delayUs: 9.0, soundLevelDb: 70.0, confidence: 0.92 }, // Next frame (+50ms)
      ],
    };

    const fused = clockFusion.processBatch(1, batch, 1720000000100);

    // Records 0, 1, 2 must have the exact same timestamp
    expect(fused.records[0].timestampMs).toBe(fused.records[1].timestampMs);
    expect(fused.records[1].timestampMs).toBe(fused.records[2].timestampMs);

    // Record 3 must be exactly +50ms later
    expect(fused.records[3].timestampMs - fused.records[0].timestampMs).toBe(50);

    // Insert into DB and verify retrieval preserves Primary -> Secondary -> Tertiary order
    measurementService.insertBatch(1, { header: batch.header, records: fused.records });
    const stored = measurementService.getLatestMeasurements(1, 0, 10);
    expect(stored.length).toBe(4);

    expect(stored[0].angle_deg).toBeCloseTo(-45.0, 1);
    expect(stored[1].angle_deg).toBeCloseTo(60.0, 1);
    expect(stored[2].angle_deg).toBeCloseTo(120.0, 1);
    expect(stored[3].angle_deg).toBeCloseTo(-40.0, 1);
  });

  it('6. Cubic Hermite Slew across SERVER_UTC -> SNTP_UTC Negative Step: smoothly transitions without time reversal', () => {
    const tServer = 1720000000000;
    // Step 1: Device sends SERVER_UTC batch
    const batch1 = {
      header: {
        clockFlags: CLOCK_FLAG_SERVER_SYNCHRONIZED,
        baseTimestampMs: BigInt(tServer),
        clockSource: 'SERVER_UTC',
      },
      records: [{ offsetMs: 0, angleDeg: 0, delayUs: 0, soundLevelDb: 60, confidence: 0.8 }],
    };
    const fused1 = clockFusion.processBatch(1, batch1, tServer);
    expect(fused1.syncQuality).toBe(SYNC_QUALITY_SERVER_SYNCED);

    // Step 2: 100ms later, SNTP locks in with a negative step error (-400ms)
    // Hardware sends baseTimestampMs = tServer + 100 - 400 = tServer - 300
    const tRecv2 = tServer + 100;
    const batch2 = {
      header: {
        clockFlags: CLOCK_FLAG_UTC_SYNCHRONIZED,
        baseTimestampMs: BigInt(tServer - 300),
        clockSource: 'SNTP_UTC',
      },
      records: [{ offsetMs: 0, angleDeg: 10, delayUs: 0, soundLevelDb: 62, confidence: 0.85 }],
    };
    const fused2 = clockFusion.processBatch(1, batch2, tRecv2);

    // Monotonicity check: unified timestamp must NOT jump backward!
    expect(fused2.records[0].timestampMs).toBeGreaterThan(fused1.records[0].timestampMs);

    // Step 3: Send subsequent batches during slew horizon and verify strictly increasing progress (dT/dt > 0)
    let lastTs = fused2.records[0].timestampMs;
    for (let step = 1; step <= 5; step++) {
      const stepRecvMs = tRecv2 + step * 200;
      const stepRawBaseMs = tServer - 300 + step * 200;
      const stepBatch = {
        header: {
          clockFlags: CLOCK_FLAG_UTC_SYNCHRONIZED,
          baseTimestampMs: BigInt(stepRawBaseMs),
          clockSource: 'SNTP_UTC',
        },
        records: [{ offsetMs: 0, angleDeg: 10, delayUs: 0, soundLevelDb: 60, confidence: 0.8 }],
      };
      const stepFused = clockFusion.processBatch(1, stepBatch, stepRecvMs);
      expect(stepFused.records[0].timestampMs).toBeGreaterThan(lastTs);
      lastTs = stepFused.records[0].timestampMs;
    }
  });

  it('7. Hardware Reboot Detection vs Out-of-Order Packet: distinguishes reboot from minor network jitter', () => {
    // Normal session running for 60 seconds
    const batch1 = {
      header: {
        clockFlags: CLOCK_FLAG_MONOTONIC_UPTIME,
        baseTimestampMs: 60000n,
        clockSource: 'MONOTONIC_UPTIME',
      },
      records: [{ offsetMs: 50, angleDeg: 10, delayUs: 0, soundLevelDb: 60, confidence: 0.8 }],
    };
    const fused1 = clockFusion.processBatch(1, batch1, 1720000060050);
    const initialSessionId = fused1.sessionId;

    // A small rollback (100ms) due to out-of-order UDP/HTTP retry does NOT trigger reboot
    const batchOoo = {
      header: {
        clockFlags: CLOCK_FLAG_MONOTONIC_UPTIME,
        baseTimestampMs: 59900n,
        clockSource: 'MONOTONIC_UPTIME',
      },
      records: [{ offsetMs: 10, angleDeg: 10, delayUs: 0, soundLevelDb: 60, confidence: 0.8 }],
    };
    const fusedOoo = clockFusion.processBatch(1, batchOoo, 1720000060060);
    expect(fusedOoo.sessionId).toBe(initialSessionId);

    // A hard rollback to t_mono = 500ms after 60 seconds indicates a physical hardware reboot
    const batchReboot = {
      header: {
        clockFlags: CLOCK_FLAG_MONOTONIC_UPTIME,
        baseTimestampMs: 500n,
        clockSource: 'MONOTONIC_UPTIME',
      },
      records: [{ offsetMs: 20, angleDeg: 15, delayUs: 0, soundLevelDb: 65, confidence: 0.85 }],
    };
    const fusedReboot = clockFusion.processBatch(1, batchReboot, 1720000065000);
    expect(fusedReboot.sessionId).not.toBe(initialSessionId);
    expect(fusedReboot.records[0].timestampMs).toBeGreaterThan(fused1.records[0].timestampMs);
  });

  it('8. Future-Timestamp Poisoning Protection: corrupt year 2099 timestamp is demoted and does not poison subsequent batches', () => {
    const normalRecvMs = 1720000000000;
    const corruptFutureEpochMs = 4070908800000n; // Year 2099

    const corruptBatch = {
      header: {
        clockFlags: CLOCK_FLAG_UTC_SYNCHRONIZED,
        baseTimestampMs: corruptFutureEpochMs,
        clockSource: 'SNTP_UTC',
      },
      records: [{ offsetMs: 0, angleDeg: 0, delayUs: 0, soundLevelDb: 60, confidence: 0.8 }],
    };

    const fusedCorrupt = clockFusion.processBatch(1, corruptBatch, normalRecvMs);
    // Demoted to server-anchored monotonic estimate because it is > 15m in the future
    expect(fusedCorrupt.syncQuality).toBe(SYNC_QUALITY_MONOTONIC_EST);
    expect(fusedCorrupt.records[0].timestampMs).toBeLessThanOrEqual(normalRecvMs);

    // Subsequent normal batch must NOT be pinned to Year 2099
    const validBatch = {
      header: {
        clockFlags: CLOCK_FLAG_UTC_SYNCHRONIZED,
        baseTimestampMs: BigInt(normalRecvMs + 500),
        clockSource: 'SNTP_UTC',
      },
      records: [{ offsetMs: 0, angleDeg: 5, delayUs: 0, soundLevelDb: 62, confidence: 0.9 }],
    };
    const fusedValid = clockFusion.processBatch(1, validBatch, normalRecvMs + 500);
    expect(fusedValid.syncQuality).toBe(SYNC_QUALITY_SNTP_LOCKED);
    expect(fusedValid.records[0].timestampMs).toBe(normalRecvMs + 500);
  });
});
