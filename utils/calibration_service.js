import { validateCalibrationUpdate } from './validator.js';

export class CalibrationService {
  constructor(db) {
    this.db = db;
  }

  getCalibration(deviceId) {
    const stmt = this.db.prepare(`
      SELECT device_id, microphone_distance_m, sample_rate, window_size,
             correlation_threshold, sound_level_threshold_db, db_spl_offset,
             angle_offset_deg, adaptive_threshold_enabled, snr_margin_db
      FROM device_calibration
      WHERE device_id = ?
    `);
    const row = stmt.get(deviceId);
    if (!row) return null;

    return {
      device_id: row.device_id,
      microphone_distance_m: row.microphone_distance_m,
      sample_rate: row.sample_rate,
      window_size: row.window_size,
      correlation_threshold: row.correlation_threshold,
      sound_level_threshold_db: row.sound_level_threshold_db,
      db_spl_offset: row.db_spl_offset,
      angle_offset_deg: row.angle_offset_deg,
      adaptive_threshold_enabled: Boolean(row.adaptive_threshold_enabled),
      snr_margin_db: row.snr_margin_db,
      server_time_unix_ms: Date.now(),
    };
  }

  updateCalibration(deviceId, input) {
    const validation = validateCalibrationUpdate(input);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const current = this.getCalibration(deviceId);
    if (!current) {
      return { success: false, error: `Device ${deviceId} not found` };
    }

    const updated = {
      microphone_distance_m: input.microphone_distance_m ?? current.microphone_distance_m,
      sample_rate: input.sample_rate ?? current.sample_rate,
      correlation_threshold: input.correlation_threshold ?? current.correlation_threshold,
      sound_level_threshold_db: input.sound_level_threshold_db ?? current.sound_level_threshold_db,
      db_spl_offset: input.db_spl_offset ?? current.db_spl_offset,
      angle_offset_deg: input.angle_offset_deg ?? current.angle_offset_deg,
      adaptive_threshold_enabled:
        input.adaptive_threshold_enabled !== undefined
          ? input.adaptive_threshold_enabled ? 1 : 0
          : current.adaptive_threshold_enabled ? 1 : 0,
      snr_margin_db: input.snr_margin_db ?? current.snr_margin_db,
      updated_at: new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      UPDATE device_calibration
      SET microphone_distance_m = ?,
          sample_rate = ?,
          correlation_threshold = ?,
          sound_level_threshold_db = ?,
          db_spl_offset = ?,
          angle_offset_deg = ?,
          adaptive_threshold_enabled = ?,
          snr_margin_db = ?,
          updated_at = ?
      WHERE device_id = ?
    `);

    stmt.run(
      updated.microphone_distance_m,
      updated.sample_rate,
      updated.correlation_threshold,
      updated.sound_level_threshold_db,
      updated.db_spl_offset,
      updated.angle_offset_deg,
      updated.adaptive_threshold_enabled,
      updated.snr_margin_db,
      updated.updated_at,
      deviceId
    );

    return { success: true, data: this.getCalibration(deviceId) };
  }

  calibrateZeroAngle(deviceId, sampleCount = 20) {
    const current = this.getCalibration(deviceId);
    if (!current) {
      throw new Error(`Device ${deviceId} not found`);
    }

    // Get the most recent N valid measurements with high confidence
    const stmt = this.db.prepare(`
      SELECT angle_deg, confidence
      FROM measurements
      WHERE device_id = ? AND confidence >= 0.3
      ORDER BY timestamp_ms DESC
      LIMIT ?
    `);
    const rows = stmt.all(deviceId, sampleCount);

    if (rows.length === 0) {
      return {
        success: false,
        previousOffset: current.angle_offset_deg,
        newOffset: current.angle_offset_deg,
        samplesUsed: 0,
      };
    }

    // Compute circular mean: sum(sin(angle)), sum(cos(angle))
    let sumSin = 0;
    let sumCos = 0;
    for (const r of rows) {
      const rad = (r.angle_deg * Math.PI) / 180.0;
      sumSin += Math.sin(rad) * r.confidence;
      sumCos += Math.cos(rad) * r.confidence;
    }

    const meanRad = Math.atan2(sumSin, sumCos);
    const meanDeg = (meanRad * 180.0) / Math.PI;

    // To bring detected meanDeg to 0 degrees, new angle_offset = previous_offset - meanDeg
    let newOffset = current.angle_offset_deg - meanDeg;
    // Wrap to [-180, +180]
    while (newOffset > 180.0) newOffset -= 360.0;
    while (newOffset < -180.0) newOffset += 360.0;

    this.updateCalibration(deviceId, { angle_offset_deg: Number(newOffset.toFixed(2)) });

    return {
      success: true,
      previousOffset: current.angle_offset_deg,
      newOffset: Number(newOffset.toFixed(2)),
      samplesUsed: rows.length,
    };
  }
}

export default CalibrationService;
