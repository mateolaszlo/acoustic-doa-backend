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

export const SECTOR_WIDTH_MIN_DEG = 5.0;
export const SECTOR_WIDTH_MAX_DEG = 90.0;

export const SECTOR_HYSTERESIS_MIN_DEG = 0.0;
export const SECTOR_HYSTERESIS_MAX_DEG = 15.0;

export const TRACKER_HOLD_MIN_MS = 200;
export const TRACKER_HOLD_MAX_MS = 30000;

export const SUPPORTED_SAMPLE_RATES = [44100, 48000];
export const REQUIRED_WINDOW_SIZE = 1024;

const CALIBRATION_RANGE_RULES = [
  { key: 'microphone_distance_m', min: MIN_MIC_DISTANCE_M, max: MAX_MIC_DISTANCE_M, unit: ' m' },
  { key: 'correlation_threshold', min: CORRELATION_THRESHOLD_MIN, max: CORRELATION_THRESHOLD_MAX, unit: '' },
  { key: 'sound_level_threshold_db', min: SPL_THRESHOLD_MIN_DB, max: SPL_THRESHOLD_MAX_DB, unit: ' dB' },
  { key: 'db_spl_offset', min: DB_SPL_OFFSET_MIN_DB, max: DB_SPL_OFFSET_MAX_DB, unit: ' dB' },
  { key: 'angle_offset_deg', min: ANGLE_OFFSET_MIN_DEG, max: ANGLE_OFFSET_MAX_DEG, unit: ' deg' },
  { key: 'snr_margin_db', min: SNR_MARGIN_MIN_DB, max: SNR_MARGIN_MAX_DB, unit: ' dB' },
  { key: 'sector_width_deg', alias: 'sector_width', min: SECTOR_WIDTH_MIN_DEG, max: SECTOR_WIDTH_MAX_DEG, unit: ' deg' },
  { key: 'sector_hysteresis_deg', alias: 'hysteresis_deg', min: SECTOR_HYSTERESIS_MIN_DEG, max: SECTOR_HYSTERESIS_MAX_DEG, unit: ' deg' },
  { key: 'tracker_hold_timeout_ms', alias: 'hold_timeout_ms', min: TRACKER_HOLD_MIN_MS, max: TRACKER_HOLD_MAX_MS, unit: ' ms' },
];

export function validateCalibrationUpdate(input) {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Request body must be a valid JSON object' };
  }

  if (input.sample_rate !== undefined && !SUPPORTED_SAMPLE_RATES.includes(input.sample_rate)) {
    return { valid: false, error: 'sample_rate must be 44100 or 48000 Hz' };
  }

  if (input.window_size !== undefined && input.window_size !== REQUIRED_WINDOW_SIZE) {
    return { valid: false, error: `window_size must be ${REQUIRED_WINDOW_SIZE}` };
  }

  const resolvedValues = {};
  for (const rule of CALIBRATION_RANGE_RULES) {
    const val = input[rule.key] !== undefined ? input[rule.key] : (rule.alias ? input[rule.alias] : undefined);
    if (val === undefined) continue;

    if (!Number.isFinite(val) || val < rule.min || val > rule.max) {
      return { valid: false, error: `${rule.key} must be between ${rule.min} and ${rule.max}${rule.unit}` };
    }
    resolvedValues[rule.key] = val;
  }

  if (
    resolvedValues.sector_hysteresis_deg !== undefined &&
    resolvedValues.sector_width_deg !== undefined &&
    resolvedValues.sector_hysteresis_deg > resolvedValues.sector_width_deg
  ) {
    return {
      valid: false,
      error: `sector_hysteresis_deg (${resolvedValues.sector_hysteresis_deg}) cannot exceed sector_width_deg (${resolvedValues.sector_width_deg})`,
    };
  }

  return { valid: true };
}
