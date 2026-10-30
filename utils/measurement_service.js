export class MeasurementService {
  constructor(db) {
    this.db = db;
  }

  insertBatch(deviceId, batch) {
    const insertStmt = this.db.prepare(`
      INSERT INTO measurements (
        device_id, timestamp_ms, raw_timestamp_ms, clock_flags,
        sync_quality, session_id, angle_deg, delay_us,
        sound_level_db, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const nowIso = new Date().toISOString();

    const insertTransaction = this.db.transaction(() => {
      for (const r of batch.records) {
        insertStmt.run(
          deviceId,
          r.timestampMs,
          r.rawTimestampMs !== undefined ? r.rawTimestampMs : r.timestampMs,
          batch.header.clockFlags,
          r.syncQuality !== undefined ? r.syncQuality : 0,
          r.sessionId !== undefined ? r.sessionId : null,
          r.angleDeg,
          r.delayUs,
          r.soundLevelDb,
          r.confidence,
          nowIso
        );
      }
    });

    insertTransaction();
    return batch.records.length;
  }

  getLatestMeasurements(deviceId, sinceTimestampMs = 0, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT id, timestamp_ms, raw_timestamp_ms, clock_flags, sync_quality, session_id,
             angle_deg, delay_us, sound_level_db, confidence
      FROM measurements
      WHERE device_id = ? AND timestamp_ms > ?
      ORDER BY timestamp_ms DESC, id DESC
      LIMIT ?
    `);
    const rows = stmt.all(deviceId, sinceTimestampMs, limit);
    return rows.reverse(); // Return in chronological order
  }

  queryMeasurements(deviceId, options = {}) {
    const conditions = ['device_id = ?'];
    const params = [deviceId];

    if (options.startTime !== undefined) {
      conditions.push('timestamp_ms >= ?');
      params.push(options.startTime);
    }
    if (options.endTime !== undefined) {
      conditions.push('timestamp_ms <= ?');
      params.push(options.endTime);
    }
    if (options.minConfidence !== undefined) {
      conditions.push('confidence >= ?');
      params.push(options.minConfidence);
    }
    if (options.minSplDb !== undefined) {
      conditions.push('sound_level_db >= ?');
      params.push(options.minSplDb);
    }

    const whereClause = conditions.join(' AND ');

    const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM measurements WHERE ${whereClause}`);
    const countRow = countStmt.get(...params);

    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const dataStmt = this.db.prepare(`
      SELECT id, timestamp_ms, raw_timestamp_ms, clock_flags, sync_quality, session_id,
             angle_deg, delay_us, sound_level_db, confidence
      FROM measurements
      WHERE ${whereClause}
      ORDER BY timestamp_ms DESC, id DESC
      LIMIT ? OFFSET ?
    `);
    const records = dataStmt.all(...params, limit, offset);

    return {
      total: countRow.count,
      records,
    };
  }

  getTotalCount(deviceId) {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM measurements WHERE device_id = ?');
    const row = stmt.get(deviceId);
    return row ? row.count : 0;
  }

  clearDeviceMeasurements(deviceId) {
    const stmt = this.db.prepare('DELETE FROM measurements WHERE device_id = ?');
    const result = stmt.run(deviceId);
    return { success: true, deleted: result.changes };
  }

  getStats(deviceId, timeframe = '1h', sinceMs = null) {
    let durationMs = 3600000;
    if (timeframe === '15m') durationMs = 15 * 60 * 1000;
    else if (timeframe === '24h') durationMs = 24 * 3600 * 1000;
    else if (timeframe === '7d') durationMs = 7 * 24 * 3600 * 1000;

    let cutoffMs = Date.now() - durationMs;
    if (sinceMs && !isNaN(sinceMs) && sinceMs > cutoffMs) {
      cutoffMs = sinceMs;
    }

    // Aggregate metrics
    const aggStmt = this.db.prepare(`
      SELECT COUNT(*) as count,
             AVG(sound_level_db) as avg_spl,
             MAX(sound_level_db) as peak_spl
      FROM measurements
      WHERE device_id = ? AND timestamp_ms >= ?
    `);
    const agg = aggStmt.get(deviceId, cutoffMs);

    // 36 angular bins of 10 degrees each: [-180, -170), [-170, -160), ..., [+170, +180]
    const bins = new Array(36).fill(0);

    const angleStmt = this.db.prepare(`
      SELECT angle_deg, confidence
      FROM measurements
      WHERE device_id = ? AND timestamp_ms >= ?
    `);
    const angleRows = angleStmt.all(deviceId, cutoffMs);

    for (const r of angleRows) {
      // Map angle in [-180, 180] to bin 0..35
      let normalized = r.angle_deg + 180.0;
      if (normalized >= 360.0) normalized = 359.9;
      if (normalized < 0.0) normalized = 0.0;
      const binIdx = Math.floor(normalized / 10.0);
      bins[binIdx]++;
    }

    return {
      deviceId,
      timeframe,
      eventCount: agg.count || 0,
      avgSplDb: agg.avg_spl ? Number(agg.avg_spl.toFixed(1)) : 0,
      peakSplDb: agg.peak_spl ? Number(agg.peak_spl.toFixed(1)) : 0,
      angularBins36: bins,
    };
  }
}

export default MeasurementService;
