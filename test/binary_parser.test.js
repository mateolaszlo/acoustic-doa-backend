import { describe, it, expect } from 'vitest';
import {
  parseBinaryBatch,
  encodeBinaryBatch,
  calculateBatchCrc32,
  MEASUREMENT_BATCH_HEADER_SIZE,
  MEASUREMENT_RECORD_SIZE,
  MEASUREMENT_BATCH_CRC_SIZE,
  CLOCK_FLAG_UTC_SYNCHRONIZED,
  CLOCK_FLAG_SERVER_SYNCHRONIZED,
  CLOCK_FLAG_MONOTONIC_UPTIME,
} from '../utils/binary_parser.js';

describe('Binary Protocol Parser (POST /api/v1/measurements)', () => {
  it('validates standard IEEE 802.3 CRC32 test vector ("123456789" -> 0xCBF43926)', () => {
    const testVector = Buffer.from('123456789', 'ascii');
    const crc = calculateBatchCrc32(testVector);
    expect(crc).toBe(0xCBF43926);
    expect('0x' + crc.toString(16).toUpperCase()).toBe('0xCBF43926');
  });

  it('correctly decodes a valid single-record binary batch with 4-byte CRC32 trailer (36 bytes)', () => {
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
    expect(buffer.length).toBe(12 + 20 + 4); // 36 bytes

    const res = parseBinaryBatch(buffer);
    expect(res.success).toBe(true);
    expect(res.batch).toBeDefined();

    const batch = res.batch;
    expect(batch.header.formatVersion).toBe(1);
    expect(batch.header.measurementCount).toBe(1);
    expect(batch.header.clockSource).toBe('SNTP_UTC');
    expect(batch.header.baseTimestampMs).toBe(baseMs);
    expect(batch.header.crcVerified).toBe(true);
    expect(typeof batch.header.crc).toBe('number');

    expect(batch.records.length).toBe(1);
    const r = batch.records[0];
    expect(r.offsetMs).toBe(25);
    expect(r.timestampMs).toBe(1791830000025);
    expect(r.angleDeg).toBeCloseTo(45.0, 1);
    expect(r.delayUs).toBeCloseTo(85.5, 1);
    expect(r.soundLevelDb).toBeCloseTo(68.2, 1);
    expect(r.confidence).toBeCloseTo(0.91, 2);
  });

  it('correctly decodes a maximum 24-record batch (496 bytes)', () => {
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
    expect(buffer.length).toBe(12 + 24 * 20 + 4); // 496 bytes

    const res = parseBinaryBatch(buffer);
    expect(res.success).toBe(true);
    expect(res.batch.records.length).toBe(24);
    expect(res.batch.header.clockSource).toBe('SERVER_UTC');
    expect(res.batch.header.crcVerified).toBe(true);
  });

  it('detects single-bit tampering in header, records, and CRC trailer', () => {
    const baseMs = 1791830000000n;
    const records = [
      {
        offsetMs: 10,
        angleDeg: 12.5,
        delayUs: 30.0,
        soundLevelDb: 65.0,
        confidence: 0.88,
      },
    ];

    // Valid baseline buffer (36 bytes)
    const validBuffer = encodeBinaryBatch(baseMs, CLOCK_FLAG_UTC_SYNCHRONIZED, records);
    expect(parseBinaryBatch(validBuffer).success).toBe(true);

    // 1. Tamper single bit in header (byte index 2: clock_flags)
    const tamperedHeader = Buffer.from(validBuffer);
    tamperedHeader[2] ^= 0x01;
    const resHeader = parseBinaryBatch(tamperedHeader);
    expect(resHeader.success).toBe(false);
    expect(resHeader.statusCode).toBe(400);
    expect(resHeader.error).toContain('CRC32 checksum mismatch');

    // 2. Tamper single bit in record (byte index 14: sound_level_db float)
    const tamperedRecord = Buffer.from(validBuffer);
    tamperedRecord[14] ^= 0x01;
    const resRecord = parseBinaryBatch(tamperedRecord);
    expect(resRecord.success).toBe(false);
    expect(resRecord.statusCode).toBe(400);
    expect(resRecord.error).toContain('CRC32 checksum mismatch');

    // 3. Tamper single bit in trailer (byte index 33: CRC trailer byte)
    const tamperedTrailer = Buffer.from(validBuffer);
    tamperedTrailer[33] ^= 0x01;
    const resTrailer = parseBinaryBatch(tamperedTrailer);
    expect(resTrailer.success).toBe(false);
    expect(resTrailer.statusCode).toBe(400);
    expect(resTrailer.error).toContain('CRC32 checksum mismatch');
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
    expect(res.batch.header.clockSource).toBe('MONOTONIC_UPTIME');
  });

  it('rejects payloads smaller than 16 bytes (12-byte header + 4-byte CRC trailer)', () => {
    const smallBuffer = Buffer.from([1, 2, 3, 4]);
    const res = parseBinaryBatch(smallBuffer);
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Payload too small');
  });

  it('rejects version numbers other than 1', () => {
    const buffer = Buffer.alloc(36);
    buffer.writeUInt8(2, 0); // Invalid version 2
    buffer.writeUInt8(1, 1);
    const res = parseBinaryBatch(buffer);
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Unsupported format version');
  });

  it('rejects payload size mismatches (missing or truncated CRC trailer)', () => {
    const buffer = Buffer.alloc(32); // Legacy size without 4-byte CRC
    buffer.writeUInt8(1, 0); // version 1
    buffer.writeUInt8(1, 1); // 1 record declared (requires 36 bytes)
    const res = parseBinaryBatch(buffer);
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Buffer size mismatch');
    expect(res.error).toContain('including 4-byte CRC32 trailer');
  });

  it('rejects out-of-range azimuth angles when CRC is valid', () => {
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
