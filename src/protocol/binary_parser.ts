import {
  MEASUREMENT_BATCH_VERSION,
  MEASUREMENT_BATCH_HEADER_SIZE,
  MEASUREMENT_RECORD_SIZE,
  CLOCK_FLAG_UTC_SYNCHRONIZED,
  CLOCK_FLAG_SERVER_SYNCHRONIZED,
  CLOCK_FLAG_SERVER_MIDPOINT,
  CLOCK_FLAG_MONOTONIC_UPTIME,
  BatchHeader,
  DecodedBatch,
  DecodedMeasurement,
  ClockSource,
} from './binary_types.js';

export interface ParseResult {
  success: boolean;
  batch?: DecodedBatch;
  error?: string;
  statusCode?: number;
}

export function parseBinaryBatch(buffer: Buffer): ParseResult {
  if (buffer.length < MEASUREMENT_BATCH_HEADER_SIZE) {
    return {
      success: false,
      statusCode: 400,
      error: `Payload too small: ${buffer.length} bytes (minimum header size is ${MEASUREMENT_BATCH_HEADER_SIZE} bytes)`,
    };
  }

  // 1. Decode 12-byte header (Little-Endian)
  const formatVersion = buffer.readUInt8(0);
  const measurementCount = buffer.readUInt8(1);
  const clockFlags = buffer.readUInt16LE(2);
  const baseTimestampMs = buffer.readBigUInt64LE(4);

  if (formatVersion !== MEASUREMENT_BATCH_VERSION) {
    return {
      success: false,
      statusCode: 400,
      error: `Unsupported format version ${formatVersion}; expected version ${MEASUREMENT_BATCH_VERSION}`,
    };
  }

  if (measurementCount < 1 || measurementCount > 24) {
    return {
      success: false,
      statusCode: 400,
      error: `Invalid measurement count ${measurementCount}; must be between 1 and 24 records`,
    };
  }

  const expectedTotalSize = MEASUREMENT_BATCH_HEADER_SIZE + measurementCount * MEASUREMENT_RECORD_SIZE;
  if (buffer.length !== expectedTotalSize) {
    return {
      success: false,
      statusCode: 400,
      error: `Buffer size mismatch: declared ${measurementCount} records requires ${expectedTotalSize} bytes, but received ${buffer.length} bytes`,
    };
  }

  let clockSource: ClockSource = 'UNKNOWN';
  if ((clockFlags & CLOCK_FLAG_UTC_SYNCHRONIZED) !== 0) {
    clockSource = 'SNTP_UTC';
  } else if ((clockFlags & (CLOCK_FLAG_SERVER_SYNCHRONIZED | CLOCK_FLAG_SERVER_MIDPOINT)) !== 0) {
    clockSource = 'SERVER_UTC';
  } else if ((clockFlags & CLOCK_FLAG_MONOTONIC_UPTIME) !== 0) {
    clockSource = 'MONOTONIC_UPTIME';
  }

  const header: BatchHeader = {
    formatVersion,
    measurementCount,
    clockFlags,
    baseTimestampMs,
    clockSource,
  };

  // 2. Decode contiguous 20-byte records
  const records: DecodedMeasurement[] = [];
  let offset = MEASUREMENT_BATCH_HEADER_SIZE;
  const baseMsNumber = Number(baseTimestampMs);

  for (let i = 0; i < measurementCount; i++) {
    const offsetMs = buffer.readUInt32LE(offset);
    const angleDeg = buffer.readFloatLE(offset + 4);
    const delayUs = buffer.readFloatLE(offset + 8);
    const soundLevelDb = buffer.readFloatLE(offset + 12);
    const confidence = buffer.readFloatLE(offset + 16);

    // Validation per record
    if (!Number.isFinite(angleDeg) || angleDeg < -180.0 || angleDeg > 180.0) {
      return {
        success: false,
        statusCode: 400,
        error: `Record ${i}: invalid angle_deg ${angleDeg} (must be in [-180, +180])`,
      };
    }

    if (!Number.isFinite(soundLevelDb) || soundLevelDb < -200.0 || soundLevelDb > 200.0) {
      return {
        success: false,
        statusCode: 400,
        error: `Record ${i}: invalid sound_level_db ${soundLevelDb}`,
      };
    }

    if (!Number.isFinite(confidence) || confidence < 0.0 || confidence > 1.0) {
      return {
        success: false,
        statusCode: 400,
        error: `Record ${i}: invalid confidence ${confidence} (must be in [0.0, 1.0])`,
      };
    }

    records.push({
      offsetMs,
      timestampMs: baseMsNumber + offsetMs,
      angleDeg,
      delayUs,
      soundLevelDb,
      confidence,
    });

    offset += MEASUREMENT_RECORD_SIZE;
  }

  return {
    success: true,
    batch: {
      header,
      records,
    },
  };
}

/**
 * Encodes a synthetic batch for testing or simulation
 */
export function encodeBinaryBatch(
  baseTimestampMs: bigint,
  clockFlags: number,
  records: Array<{
    offsetMs: number;
    angleDeg: number;
    delayUs: number;
    soundLevelDb: number;
    confidence: number;
  }>
): Buffer {
  const count = records.length;
  if (count < 1 || count > 24) {
    throw new Error(`Record count ${count} must be between 1 and 24`);
  }

  const totalSize = MEASUREMENT_BATCH_HEADER_SIZE + count * MEASUREMENT_RECORD_SIZE;
  const buffer = Buffer.alloc(totalSize);

  // 12-byte header
  buffer.writeUInt8(MEASUREMENT_BATCH_VERSION, 0);
  buffer.writeUInt8(count, 1);
  buffer.writeUInt16LE(clockFlags, 2);
  buffer.writeBigUInt64LE(baseTimestampMs, 4);

  // 20-byte records
  let offset = MEASUREMENT_BATCH_HEADER_SIZE;
  for (const r of records) {
    buffer.writeUInt32LE(r.offsetMs, offset);
    buffer.writeFloatLE(r.angleDeg, offset + 4);
    buffer.writeFloatLE(r.delayUs, offset + 8);
    buffer.writeFloatLE(r.soundLevelDb, offset + 12);
    buffer.writeFloatLE(r.confidence, offset + 16);
    offset += MEASUREMENT_RECORD_SIZE;
  }

  return buffer;
}
