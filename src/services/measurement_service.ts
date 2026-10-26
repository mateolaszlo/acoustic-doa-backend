import Database from 'better-sqlite3';
import { DecodedBatch } from '../protocol/binary_types.js';

export interface QueryOptions {
  startTime?: number;
  endTime?: number;
  minConfidence?: number;
  minSplDb?: number;
  limit?: number;
  offset?: number;
}

export class MeasurementService {
  constructor(private db: Database.Database) {}

  public insertBatch(deviceId: number, batch: DecodedBatch): number {
    const insertStmt = this.db.prepare(`
      INSERT INTO measurements (
        device_id, timestamp_ms, clock_flags, angle_deg, delay_us,
        sound_level_db, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const nowIso = new Date().toISOString();

    const insertTransaction = this.db.transaction(() => {
      for (const r of batch.records) {
        insertStmt.run(
          deviceId,
          r.timestampMs,
          batch.header.clockFlags,
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

  public getLatestMeasurements(deviceId: number, sinceTimestampMs = 0, limit = 50): Array<any> {
    const stmt = this.db.prepare(`
      SELECT id, timestamp_ms, angle_deg, delay_us, sound_level_db, confidence
      FROM measurements
      WHERE device_id = ? AND timestamp_ms > ?
      ORDER BY timestamp_ms DESC
      LIMIT ?
    `);
    const rows = stmt.all(deviceId, sinceTimestampMs, limit) as any[];
    return rows.reverse(); // Return in chronological order
  }

  public queryMeasurements(deviceId: number, options: QueryOptions): { total: number; records: any[] } {
    const conditions = ['device_id = ?'];
    const params: any[] = [deviceId];

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
    const countRow = countStmt.get(...params) as { count: number };

    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const dataStmt = this.db.prepare(`
      SELECT id, timestamp_ms, angle_deg, delay_us, sound_level_db, confidence
      FROM measurements
      WHERE ${whereClause}
      ORDER BY timestamp_ms DESC
      LIMIT ? OFFSET ?
    `);
    const records = dataStmt.all(...params, limit, offset);

    return {
      total: countRow.count,
      records,
    };
  }

  public getStats(deviceId: number, timeframe = '1h'): any {
    let durationMs = 3600000;
    if (timeframe === '15m') durationMs = 15 * 60 * 1000;
    else if (timeframe === '24h') durationMs = 24 * 3600 * 1000;
    else if (timeframe === '7d') durationMs = 7 * 24 * 3600 * 1000;

    const cutoffMs = Date.now() - durationMs;

    // Aggregate metrics
    const aggStmt = this.db.prepare(`
      SELECT COUNT(*) as count,
             AVG(sound_level_db) as avg_spl,
             MAX(sound_level_db) as peak_spl
      FROM measurements
      WHERE device_id = ? AND timestamp_ms >= ?
    `);
    const agg = aggStmt.get(deviceId, cutoffMs) as any;

    // 36 angular bins of 10 degrees each: [-180, -170), [-170, -160), ..., [+170, +180]
    const bins = new Array(36).fill(0);

    const angleStmt = this.db.prepare(`
      SELECT angle_deg, confidence
      FROM measurements
      WHERE device_id = ? AND timestamp_ms >= ?
    `);
    const angleRows = angleStmt.all(deviceId, cutoffMs) as Array<{ angle_deg: number; confidence: number }>;

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
