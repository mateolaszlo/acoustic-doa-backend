/**
 * Acoustic parameter validation matching firmware bounds (src/config/app_config.h & device_config.h)
 */

export const MIN_MIC_DISTANCE_M = 0.02;
export const MAX_MIC_DISTANCE_M = 0.11;

export const CORRELATION_THRESHOLD_MIN = 0.10;
export const CORRELATION_THRESHOLD_MAX = 1.00;

export const SPL_THRESHOLD_MIN_DB = -200.0;
export const SPL_THRESHOLD_MAX_DB = 200.0;

export const DB_SPL_OFFSET_MIN_DB = -100.0;
export const DB_SPL_OFFSET_MAX_DB = 200.0;

export const ANGLE_OFFSET_MIN_DEG = -180.0;
export const ANGLE_OFFSET_MAX_DEG = 180.0;

export const SNR_MARGIN_MIN_DB = 0.0;
export const SNR_MARGIN_MAX_DB = 60.0;

export const SUPPORTED_SAMPLE_RATES = [44100, 48000];
export const REQUIRED_WINDOW_SIZE = 1024;

export function validateCalibrationUpdate(input) {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Request body must be a valid JSON object' };
  }

  if (input.microphone_distance_m !== undefined) {
    if (!Number.isFinite(input.microphone_distance_m) ||
        input.microphone_distance_m < MIN_MIC_DISTANCE_M ||
        input.microphone_distance_m > MAX_MIC_DISTANCE_M) {
      return { valid: false, error: `microphone_distance_m must be between ${MIN_MIC_DISTANCE_M} and ${MAX_MIC_DISTANCE_M} m` };
    }
  }

  if (input.sample_rate !== undefined) {
    if (!SUPPORTED_SAMPLE_RATES.includes(input.sample_rate)) {
      return { valid: false, error: `sample_rate must be 44100 or 48000 Hz` };
    }
  }

  if (input.window_size !== undefined && input.window_size !== REQUIRED_WINDOW_SIZE) {
    return { valid: false, error: `window_size must be ${REQUIRED_WINDOW_SIZE}` };
  }

  if (input.correlation_threshold !== undefined) {
    if (!Number.isFinite(input.correlation_threshold) ||
        input.correlation_threshold < CORRELATION_THRESHOLD_MIN ||
        input.correlation_threshold > CORRELATION_THRESHOLD_MAX) {
      return { valid: false, error: `correlation_threshold must be between ${CORRELATION_THRESHOLD_MIN} and ${CORRELATION_THRESHOLD_MAX}` };
    }
  }

  if (input.sound_level_threshold_db !== undefined) {
    if (!Number.isFinite(input.sound_level_threshold_db) ||
        input.sound_level_threshold_db < SPL_THRESHOLD_MIN_DB ||
        input.sound_level_threshold_db > SPL_THRESHOLD_MAX_DB) {
      return { valid: false, error: `sound_level_threshold_db must be between ${SPL_THRESHOLD_MIN_DB} and ${SPL_THRESHOLD_MAX_DB} dB` };
    }
  }

  if (input.db_spl_offset !== undefined) {
    if (!Number.isFinite(input.db_spl_offset) ||
        input.db_spl_offset < DB_SPL_OFFSET_MIN_DB ||
        input.db_spl_offset > DB_SPL_OFFSET_MAX_DB) {
      return { valid: false, error: `db_spl_offset must be between ${DB_SPL_OFFSET_MIN_DB} and ${DB_SPL_OFFSET_MAX_DB} dB` };
    }
  }

  if (input.angle_offset_deg !== undefined) {
    if (!Number.isFinite(input.angle_offset_deg) ||
        input.angle_offset_deg < ANGLE_OFFSET_MIN_DEG ||
        input.angle_offset_deg > ANGLE_OFFSET_MAX_DEG) {
      return { valid: false, error: `angle_offset_deg must be between ${ANGLE_OFFSET_MIN_DEG} and ${ANGLE_OFFSET_MAX_DEG} deg` };
    }
  }

  if (input.snr_margin_db !== undefined) {
    if (!Number.isFinite(input.snr_margin_db) ||
        input.snr_margin_db < SNR_MARGIN_MIN_DB ||
        input.snr_margin_db > SNR_MARGIN_MAX_DB) {
      return { valid: false, error: `snr_margin_db must be between ${SNR_MARGIN_MIN_DB} and ${SNR_MARGIN_MAX_DB} dB` };
    }
  }

  return { valid: true };
}
