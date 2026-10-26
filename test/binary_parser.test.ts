import { describe, it, expect } from 'vitest';
import { parseBinaryBatch, encodeBinaryBatch } from '../src/protocol/binary_parser.js';
import {
  CLOCK_FLAG_UTC_SYNCHRONIZED,
  CLOCK_FLAG_SERVER_SYNCHRONIZED,
  CLOCK_FLAG_MONOTONIC_UPTIME,
} from '../src/protocol/binary_types.js';

describe('Binary Protocol Parser (POST /api/v1/measurements)', () => {
  it('correctly decodes a valid single-record binary batch', () => {
    const baseMs = 1791830000000n;
    const records = [
      {
        offsetMs: 25,
        angleDeg: 45.0,
        delayUs: 85.5,
        soundLevelDb: 68.2,
        confidence: 0.91,
      },
    ];

    const buffer = encodeBinaryBatch(baseMs, CLOCK_FLAG_UTC_SYNCHRONIZED, records);
    expect(buffer.length).toBe(12 + 20); // 32 bytes

    const res = parseBinaryBatch(buffer);
    expect(res.success).toBe(true);
    expect(res.batch).toBeDefined();

    const batch = res.batch!;
    expect(batch.header.formatVersion).toBe(1);
    expect(batch.header.measurementCount).toBe(1);
    expect(batch.header.clockSource).toBe('SNTP_UTC');
    expect(batch.header.baseTimestampMs).toBe(baseMs);

    expect(batch.records.length).toBe(1);
    const r = batch.records[0];
    expect(r.offsetMs).toBe(25);
    expect(r.timestampMs).toBe(1791830000025);
    expect(r.angleDeg).toBeCloseTo(45.0, 1);
    expect(r.delayUs).toBeCloseTo(85.5, 1);
    expect(r.soundLevelDb).toBeCloseTo(68.2, 1);
    expect(r.confidence).toBeCloseTo(0.91, 2);
  });

  it('correctly decodes a maximum 24-record batch (492 bytes)', () => {
    const baseMs = 1791830000000n;
    const records = [];
    for (let i = 0; i < 24; i++) {
      records.push({
        offsetMs: i * 8,
        angleDeg: -180.0 + i * 15.0,
        delayUs: i * 5.0,
        soundLevelDb: 60.0 + i,
        confidence: 0.85,
      });
    }

    const buffer = encodeBinaryBatch(baseMs, CLOCK_FLAG_SERVER_SYNCHRONIZED, records);
    expect(buffer.length).toBe(492);

    const res = parseBinaryBatch(buffer);
    expect(res.success).toBe(true);
    expect(res.batch?.records.length).toBe(24);
    expect(res.batch?.header.clockSource).toBe('SERVER_UTC');
  });

  it('identifies monotonic uptime clock flags', () => {
    const baseMs = 54321n; // 54.3 seconds since boot
    const records = [
      {
        offsetMs: 10,
        angleDeg: 0.0,
        delayUs: 0.0,
        soundLevelDb: 55.0,
        confidence: 0.8,
      },
    ];

    const buffer = encodeBinaryBatch(baseMs, CLOCK_FLAG_MONOTONIC_UPTIME, records);
    const res = parseBinaryBatch(buffer);
    expect(res.success).toBe(true);
    expect(res.batch?.header.clockSource).toBe('MONOTONIC_UPTIME');
  });

  it('rejects payloads smaller than 12 bytes', () => {
    const smallBuffer = Buffer.from([1, 2, 3, 4]);
    const res = parseBinaryBatch(smallBuffer);
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Payload too small');
  });

  it('rejects version numbers other than 1', () => {
    const buffer = Buffer.alloc(32);
    buffer.writeUInt8(2, 0); // Invalid version 2
    buffer.writeUInt8(1, 1);
    const res = parseBinaryBatch(buffer);
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Unsupported format version');
  });

  it('rejects payload size mismatches', () => {
    const buffer = Buffer.alloc(40); // Expected 32 for count 1
    buffer.writeUInt8(1, 0);
    buffer.writeUInt8(1, 1); // Declared count 1
    const res = parseBinaryBatch(buffer);
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Buffer size mismatch');
  });

  it('rejects out-of-range azimuth angles', () => {
    const baseMs = 1791830000000n;
    const records = [
      {
        offsetMs: 0,
        angleDeg: 250.0, // Invalid: exceeds 180 degrees
        delayUs: 0.0,
        soundLevelDb: 60.0,
        confidence: 0.9,
      },
    ];
    const buffer = encodeBinaryBatch(baseMs, CLOCK_FLAG_UTC_SYNCHRONIZED, records);
    const res = parseBinaryBatch(buffer);
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('invalid angle_deg');
  });
});
