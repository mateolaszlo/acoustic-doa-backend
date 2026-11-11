/**
 * Binary protocol parser matching ESP32 firmware (src/network/rest_protocol.h)
 * Format version 1: 12-byte Little-Endian batch header + 20-byte per-measurement records + 4-byte CRC32 trailer
 */

import { crc32 } from 'node:zlib';

export const MEASUREMENT_BATCH_VERSION = 1;
export const MEASUREMENT_BATCH_HEADER_SIZE = 12;
export const MEASUREMENT_RECORD_SIZE = 20;
export const MEASUREMENT_BATCH_CRC_SIZE = 4;

export const CLOCK_FLAG_UTC_SYNCHRONIZED = 0x0001;
export const CLOCK_FLAG_SERVER_SYNCHRONIZED = 0x0002;
export const CLOCK_FLAG_SERVER_MIDPOINT = 0x0003;
export const CLOCK_FLAG_MONOTONIC_UPTIME = 0x0004;

export const SECTOR_EVENT_NONE = 0;
export const SECTOR_EVENT_ENTER = 1;
export const SECTOR_EVENT_MOVE = 2;
export const SECTOR_EVENT_HEARTBEAT = 3;
export const SECTOR_EVENT_LEAVE = 4;
export const INVALID_SECTOR_ID = 0xFF; // 255

export const SECTOR_EVENT_NAMES = {
  1: 'ENTER',
  2: 'MOVE',
  3: 'HEARTBEAT',
  4: 'LEAVE',
};

/**
 * Derives projected acoustic wavefront time-of-flight delay in microseconds
 * from azimuth angle and array baseline spacing (default d = 0.082 m, c = 343.9 m/s)
 * @param {number} angleDeg
 * @param {number} micDistanceM
 * @param {number} speedOfSound
 * @returns {number} Delay in microseconds
 */
export function calculateProjectedDelayUs(angleDeg, micDistanceM = 0.082, speedOfSound = 343.9) {
  if (!Number.isFinite(angleDeg)) return 0.0;
  const rad = (angleDeg * Math.PI) / 180.0;
  return Number(((micDistanceM * Math.sin(rad)) / speedOfSound * 1e6).toFixed(1));
}

/**
 * Calculates the standard IEEE 802.3 CRC32 checksum of a buffer using native zlib C bindings.
 * Matches ESP32 esp_rom_crc32_le on hardware.
 * @param {Buffer|Uint8Array} buffer
 * @returns {number} Unsigned 32-bit CRC
 */
export function calculateBatchCrc32(buffer) {
  if (!buffer || buffer.length === 0) return 0;
  return crc32(buffer);
}

/**
 * Parses a binary measurement batch payload received via POST /api/v1/measurements
 * @param {Buffer} buffer - Raw octet-stream bytes
 * @returns {{ success: boolean, batch?: object, error?: string, statusCode?: number }}
 */
export function parseBinaryBatch(buffer) {
  const minSize = MEASUREMENT_BATCH_HEADER_SIZE + MEASUREMENT_BATCH_CRC_SIZE;
  if (!buffer || buffer.length < minSize) {
    return {
      success: false,
      statusCode: 400,
      error: `Payload too small: ${buffer ? buffer.length : 0} bytes (minimum is ${minSize} bytes including 4-byte CRC32 trailer)`,
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

  const dataLength = MEASUREMENT_BATCH_HEADER_SIZE + measurementCount * MEASUREMENT_RECORD_SIZE;
  const expectedTotalSize = dataLength + MEASUREMENT_BATCH_CRC_SIZE;

  if (buffer.length !== expectedTotalSize) {
    return {
      success: false,
      statusCode: 400,
      error: `Buffer size mismatch: declared ${measurementCount} records requires ${expectedTotalSize} bytes (including 4-byte CRC32 trailer), but received ${buffer.length} bytes`,
    };
  }

  // 2. Verify IEEE 802.3 CRC32 trailer (Little-Endian unsigned 32-bit integer)
  const expectedCrc = crc32(buffer.subarray(0, dataLength));
  const trailerCrc = buffer.readUInt32LE(dataLength);

  if (expectedCrc !== trailerCrc) {
    return {
      success: false,
      statusCode: 400,
      error: `CRC32 checksum mismatch: expected 0x${expectedCrc.toString(16).padStart(8, '0').toUpperCase()}, received 0x${trailerCrc.toString(16).padStart(8, '0').toUpperCase()}`,
    };
  }

  let clockSource = 'UNKNOWN';
  if ((clockFlags & CLOCK_FLAG_MONOTONIC_UPTIME) !== 0) {
    clockSource = 'MONOTONIC_UPTIME';
  } else if ((clockFlags & CLOCK_FLAG_SERVER_SYNCHRONIZED) !== 0) {
    clockSource = 'SERVER_UTC';
  } else if ((clockFlags & CLOCK_FLAG_UTC_SYNCHRONIZED) !== 0) {
    clockSource = 'SNTP_UTC';
  }

  const header = {
    formatVersion,
    measurementCount,
    clockFlags,
    baseTimestampMs,
    clockSource,
    crcVerified: true,
    crc: expectedCrc,
  };

  // 3. Decode contiguous 20-byte records
  const records = [];
  let offset = MEASUREMENT_BATCH_HEADER_SIZE;
  const baseMsNumber = Number(baseTimestampMs);

  for (let i = 0; i < measurementCount; i++) {
    const offsetMs = buffer.readUInt32LE(offset);
    const angleDeg = buffer.readFloatLE(offset + 4);
    const slotId = buffer.readUInt8(offset + 8);
    const sectorId = buffer.readUInt8(offset + 9);
    const eventType = buffer.readUInt8(offset + 10);
    const activeSources = buffer.readUInt8(offset + 11);
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

    if (slotId > 3) {
      return {
        success: false,
        statusCode: 400,
        error: `Record ${i}: invalid slot_id ${slotId} (must be between 0 and 3)`,
      };
    }

    if (sectorId > 72 && sectorId !== INVALID_SECTOR_ID) {
      return {
        success: false,
        statusCode: 400,
        error: `Record ${i}: invalid sector_id ${sectorId} (must be <= 72 or 0xFF)`,
      };
    }

    if (eventType < 1 || eventType > 4) {
      return {
        success: false,
        statusCode: 400,
        error: `Record ${i}: invalid event_type ${eventType} (must be 1=ENTER, 2=MOVE, 3=HEARTBEAT, 4=LEAVE)`,
      };
    }

    if (activeSources > 4) {
      return {
        success: false,
        statusCode: 400,
        error: `Record ${i}: invalid active_sources ${activeSources} (must be between 0 and 4)`,
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

    const delayUs = calculateProjectedDelayUs(angleDeg);

    records.push({
      offsetMs,
      timestampMs: baseMsNumber + offsetMs,
      angleDeg,
      slotId,
      sectorId,
      eventType,
      eventTypeName: SECTOR_EVENT_NAMES[eventType] || 'UNKNOWN',
      activeSources,
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
 * Encodes a synthetic batch for testing or simulation with 4-byte CRC32 trailer
 * Records layout: offset_ms (uint32), angle_deg (float32), slot_id (uint8), sector_id (uint8),
 * event_type (uint8), active_sources (uint8), sound_level_db (float32), confidence (float32)
 */
export function encodeBinaryBatch(baseTimestampMs, clockFlags, records, sectorWidthDeg = 15.0) {
  const count = records.length;
  if (count < 1 || count > 24) {
    throw new Error(`Record count ${count} must be between 1 and 24`);
  }

  const dataSize = MEASUREMENT_BATCH_HEADER_SIZE + count * MEASUREMENT_RECORD_SIZE;
  const totalSize = dataSize + MEASUREMENT_BATCH_CRC_SIZE;
  const buffer = Buffer.alloc(totalSize);

  // 12-byte header
  buffer.writeUInt8(MEASUREMENT_BATCH_VERSION, 0);
  buffer.writeUInt8(count, 1);
  buffer.writeUInt16LE(clockFlags, 2);
  buffer.writeBigUInt64LE(BigInt(baseTimestampMs), 4);

  // 20-byte records
  let offset = MEASUREMENT_BATCH_HEADER_SIZE;
  for (const r of records) {
    const slotId = r.slotId !== undefined ? r.slotId : 0;
    const eventType = r.eventType !== undefined ? r.eventType : SECTOR_EVENT_ENTER;
    let sectorId = r.sectorId;
    if (sectorId === undefined) {
      if (eventType === SECTOR_EVENT_LEAVE) {
        sectorId = INVALID_SECTOR_ID;
      } else {
        const numSectors = Math.max(1, Math.round(360.0 / sectorWidthDeg));
        const normalized = ((r.angleDeg + 180.0) % 360.0 + 360.0) % 360.0;
        sectorId = Math.floor(normalized / sectorWidthDeg + 0.5) % numSectors;
      }
    }
    const activeSources = r.activeSources !== undefined ? r.activeSources : 1;

    buffer.writeUInt32LE(r.offsetMs, offset);
    buffer.writeFloatLE(r.angleDeg, offset + 4);
    buffer.writeUInt8(slotId, offset + 8);
    buffer.writeUInt8(sectorId, offset + 9);
    buffer.writeUInt8(eventType, offset + 10);
    buffer.writeUInt8(activeSources, offset + 11);
    buffer.writeFloatLE(r.soundLevelDb, offset + 12);
    buffer.writeFloatLE(r.confidence, offset + 16);
    offset += MEASUREMENT_RECORD_SIZE;
  }

  // 4-byte CRC32 trailer (Little-Endian)
  const crc = crc32(buffer.subarray(0, dataSize));
  buffer.writeUInt32LE(crc, dataSize);

  return buffer;
}
