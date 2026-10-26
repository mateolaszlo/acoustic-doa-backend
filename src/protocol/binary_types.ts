/**
 * Binary protocol types matching ESP32 firmware (src/network/rest_protocol.h)
 */

export const MEASUREMENT_BATCH_VERSION = 1;
export const MEASUREMENT_BATCH_HEADER_SIZE = 12;
export const MEASUREMENT_RECORD_SIZE = 20;

export const CLOCK_FLAG_UTC_SYNCHRONIZED = 0x0001;
export const CLOCK_FLAG_SERVER_SYNCHRONIZED = 0x0002;
export const CLOCK_FLAG_SERVER_MIDPOINT = 0x0003;
export const CLOCK_FLAG_MONOTONIC_UPTIME = 0x0004;

export type ClockSource = 'SNTP_UTC' | 'SERVER_UTC' | 'MONOTONIC_UPTIME' | 'UNKNOWN';

export interface BatchHeader {
  formatVersion: number;
  measurementCount: number;
  clockFlags: number;
  baseTimestampMs: bigint;
  clockSource: ClockSource;
}

export interface DecodedMeasurement {
  offsetMs: number;
  timestampMs: number;
  angleDeg: number;
  delayUs: number;
  soundLevelDb: number;
  confidence: number;
}

export interface DecodedBatch {
  header: BatchHeader;
  records: DecodedMeasurement[];
}
