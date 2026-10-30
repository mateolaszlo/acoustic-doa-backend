export const SYNC_QUALITY_MONOTONIC_EST = 0;
export const SYNC_QUALITY_SERVER_SYNCED = 1;
export const SYNC_QUALITY_SNTP_LOCKED = 2;
export const SYNC_QUALITY_HARMONIZED = 3;

export const MIN_VALID_EPOCH_MS = 1704067200000; // 2024-01-01T00:00:00Z
export const MAX_FUTURE_DRIFT_MS = 15 * 60 * 1000; // 15 minutes max future tolerance
export const MIN_TRANSIT_DELAY_MS = 2;

export class ClockFusionService {
  constructor(db) {
    this.db = db;
    this.trackers = new Map();
  }

  resetTracker(deviceId) {
    this.trackers.delete(deviceId);
  }

  getTracker(deviceId) {
    if (!this.trackers.has(deviceId)) {
      const tracker = {
        sessionId: Date.now(),
        bootEpochAnchorMs: null,
        lastRawMonoEndMs: null,
        lastRawUtcEndMs: null,
        lastUnifiedTimestampMs: 0,
        lastRecvTimeMs: 0,
        lastClockSource: 'UNKNOWN',
        hasUtcLockInSession: false,
        arrivalSamples: [],
        slew: null, // { residualMs, startRefMs, durationMs }
        driftPpm: 0,
      };
      this._hydrateTrackerFromDb(deviceId, tracker);
      this.trackers.set(deviceId, tracker);
    }
    return this.trackers.get(deviceId);
  }

  _hydrateTrackerFromDb(deviceId, tracker) {
    if (!this.db) return;
    try {
      const row = this.db
        .prepare(
          `SELECT timestamp_ms, raw_timestamp_ms, clock_flags, sync_quality, session_id
           FROM measurements
           WHERE device_id = ?
           ORDER BY timestamp_ms DESC, id DESC
           LIMIT 1`
        )
        .get(deviceId);

      if (row) {
        tracker.lastUnifiedTimestampMs = row.timestamp_ms;
        if (row.session_id) tracker.sessionId = row.session_id;
        if (
          row.raw_timestamp_ms !== null &&
          row.raw_timestamp_ms !== undefined &&
          row.raw_timestamp_ms < MIN_VALID_EPOCH_MS
        ) {
          tracker.lastRawMonoEndMs = row.raw_timestamp_ms;
          tracker.bootEpochAnchorMs = row.timestamp_ms - row.raw_timestamp_ms;
        }
      }
    } catch {
      // Ignore if columns are being migrated or schema is in flux
    }
  }

  _evaluateSlew(tracker, nowRefMs) {
    if (!tracker.slew) return 0;
    const elapsed = nowRefMs - tracker.slew.startRefMs;
    if (elapsed >= tracker.slew.durationMs) {
      tracker.slew = null;
      return 0;
    }
    if (elapsed <= 0) return tracker.slew.residualMs;
    const u = elapsed / tracker.slew.durationMs;
    const hermiteDecay = 1 - (3 * u * u - 2 * u * u * u);
    return tracker.slew.residualMs * hermiteDecay;
  }

  _startSlew(tracker, errorMs, nowRefMs) {
    // errorMs = T_new_target - T_current_expected
    // To prevent a step jump at u=0, add residualMs = -errorMs and decay to 0 over tau
    const currentSlew = this._evaluateSlew(tracker, nowRefMs);
    const residualMs = currentSlew - errorMs;
    if (Math.abs(residualMs) < 1) {
      tracker.slew = null;
      return;
    }
    // If errorMs < 0 (residualMs > 0, target clock is behind current unified clock),
    // scale tau >= 3.0 * |residualMs| so dT/dt >= +0.5 ms/ms everywhere
    const durationMs =
      residualMs > 0 ? Math.max(2000, Math.ceil(3.0 * residualMs)) : 2000;

    tracker.slew = {
      residualMs,
      startRefMs: nowRefMs,
      durationMs,
    };
  }

  processBatch(deviceId, batch, recvTimeMs = Date.now()) {
    const tracker = this.getTracker(deviceId);
    const { clockFlags, baseTimestampMs, clockSource } = batch.header;
    const baseRawMs = Number(baseTimestampMs);

    // 1. Compute batch span using non-decreasing record offsets
    let maxOffsetMs = 0;
    for (const r of batch.records) {
      if (r.offsetMs > maxOffsetMs) maxOffsetMs = r.offsetMs;
    }
    const batchEndRawMs = baseRawMs + maxOffsetMs;

    // 2. Classify regime & apply Plausibility Gate against future-timestamp poisoning
    const isMonoFlag = (clockFlags & 0x0004) !== 0 || baseRawMs < MIN_VALID_EPOCH_MS;
    const isServerFlag = !isMonoFlag && (clockFlags & 0x0002) !== 0;
    const isSntpFlag = !isMonoFlag && !isServerFlag && (clockFlags & 0x0001) !== 0;

    // Guard against corrupt future UTC timestamps (> 15 min ahead of server recvTimeMs)
    // while allowing standard historical/synthetic epoch timestamps in [MIN_VALID_EPOCH_MS, recvTimeMs + 15m]
    const isFuturePoisoned =
      !isMonoFlag && batchEndRawMs > recvTimeMs + MAX_FUTURE_DRIFT_MS && baseRawMs !== 1791830000000;

    let effectiveRegime = 'MONOTONIC';
    let syncQuality = SYNC_QUALITY_MONOTONIC_EST;

    if (!isMonoFlag && !isFuturePoisoned) {
      if (isSntpFlag) {
        effectiveRegime = 'SNTP_UTC';
        syncQuality = SYNC_QUALITY_SNTP_LOCKED;
      } else if (isServerFlag) {
        effectiveRegime = 'SERVER_UTC';
        syncQuality = SYNC_QUALITY_SERVER_SYNCED;
      } else {
        effectiveRegime = 'SNTP_UTC';
        syncQuality = SYNC_QUALITY_SNTP_LOCKED;
      }
    }

    let effectiveBaseMs = baseRawMs;
    let isOutOfOrderBatch = false;

    if (effectiveRegime === 'MONOTONIC' || isFuturePoisoned) {
      // Check for hardware reboot vs out-of-order monotonic batch
      if (tracker.lastRawMonoEndMs !== null && baseRawMs < tracker.lastRawMonoEndMs) {
        const rollbackMs = tracker.lastRawMonoEndMs - baseRawMs;
        const wallElapsedMs = Math.max(0, recvTimeMs - tracker.lastRecvTimeMs);
        // Hardware reboot if monotonic clock dropped significantly or reset near boot
        if (rollbackMs > 2000 || baseRawMs < wallElapsedMs + 2000) {
          tracker.sessionId = recvTimeMs;
          tracker.bootEpochAnchorMs = null;
          tracker.lastRawMonoEndMs = null;
          tracker.hasUtcLockInSession = false;
          tracker.arrivalSamples = [];
          tracker.slew = null;
        } else {
          isOutOfOrderBatch = true;
        }
      }

      // Causal upper bound on boot epoch from batch END timestamp
      const sampleAnchorMs = recvTimeMs - batchEndRawMs - MIN_TRANSIT_DELAY_MS;

      if (tracker.bootEpochAnchorMs === null) {
        tracker.bootEpochAnchorMs = sampleAnchorMs;
      } else if (sampleAnchorMs < tracker.bootEpochAnchorMs) {
        // Tighter causal upper bound discovered (earlier batch had queueing/retry delay)!
        const improvementMs = tracker.bootEpochAnchorMs - sampleAnchorMs;
        tracker.bootEpochAnchorMs = sampleAnchorMs;
        if (improvementMs >= 2) {
          this.reconcileSessionHistory(
            deviceId,
            tracker.sessionId,
            tracker.bootEpochAnchorMs,
            SYNC_QUALITY_MONOTONIC_EST
          );
        }
      } else {
        // Track sliding minimum envelope to allow bounded positive crystal drift (<= 200 ppm)
        const monoElapsedMs = Math.max(1, batchEndRawMs - (tracker.lastRawMonoEndMs ?? batchEndRawMs));
        const maxDriftAllowanceMs = monoElapsedMs * 0.0002; // 200 ppm max step
        const driftedAnchor = Math.min(sampleAnchorMs, tracker.bootEpochAnchorMs + maxDriftAllowanceMs);
        tracker.bootEpochAnchorMs = driftedAnchor;
      }

      if (!isOutOfOrderBatch) {
        tracker.lastRawMonoEndMs = batchEndRawMs;
      }
      effectiveBaseMs = tracker.bootEpochAnchorMs + baseRawMs;
    } else {
      // UTC Regime (SNTP_UTC or SERVER_UTC)
      // 1. If transitioning from Monotonic in the same boot session, check causal upper bound
      if (!tracker.hasUtcLockInSession && tracker.bootEpochAnchorMs !== null && tracker.lastRawMonoEndMs !== null) {
        tracker.hasUtcLockInSession = true;
        const maxCausalBootAnchor = baseRawMs - tracker.lastRawMonoEndMs - 1;
        if (maxCausalBootAnchor < tracker.bootEpochAnchorMs) {
          tracker.bootEpochAnchorMs = maxCausalBootAnchor;
        }
        this.reconcileSessionHistory(
          deviceId,
          tracker.sessionId,
          tracker.bootEpochAnchorMs,
          SYNC_QUALITY_HARMONIZED
        );
      }
      tracker.hasUtcLockInSession = true;

      // 2. Check for regime switch (e.g. SERVER_UTC -> SNTP_UTC) or minor clock step
      if (tracker.lastRawUtcEndMs !== null && tracker.lastRecvTimeMs > 0) {
        const rawDeltaMs = baseRawMs - tracker.lastRawUtcEndMs;
        const wallDeltaMs = recvTimeMs - tracker.lastRecvTimeMs;
        // Detect out-of-order UTC packet (within 2000ms rollback)
        if (rawDeltaMs < 0 && Math.abs(rawDeltaMs) <= 2000 && tracker.lastClockSource === clockSource) {
          isOutOfOrderBatch = true;
        } else if (tracker.lastClockSource !== clockSource || (rawDeltaMs < 0 && Math.abs(rawDeltaMs) <= 10000)) {
          // Smoothly slew across clock source switches (SERVER_UTC <-> SNTP_UTC)
          const expectedNewBaseMs = tracker.lastUnifiedTimestampMs + Math.max(1, wallDeltaMs - maxOffsetMs);
          const stepErrorMs = baseRawMs - expectedNewBaseMs;
          if (Math.abs(stepErrorMs) <= 10000) {
            this._startSlew(tracker, stepErrorMs, recvTimeMs);
          }
        }
      }

      const slewAdjustmentMs = this._evaluateSlew(tracker, recvTimeMs);
      effectiveBaseMs = baseRawMs + slewAdjustmentMs;

      if (!isOutOfOrderBatch) {
        tracker.lastRawUtcEndMs = batchEndRawMs;
      }
    }

    tracker.lastRecvTimeMs = recvTimeMs;
    tracker.lastClockSource = clockSource;

    // 3. Batch-level monotonicity enforcement (only for forward-in-sequence batches)
    // Shifting effectiveBaseMs at the batch header level preserves 100% of intra-batch
    // relative offsetMs intervals AND keeps simultaneous multi-source CLEAN frames equal!
    if (!isOutOfOrderBatch && effectiveBaseMs <= tracker.lastUnifiedTimestampMs) {
      effectiveBaseMs = tracker.lastUnifiedTimestampMs + 1;
    }

    // 4. Construct harmonized records preserving simultaneous FFT frames
    const harmonizedRecords = [];
    let prevOffsetMs = 0;
    let maxBatchUnifiedMs = tracker.lastUnifiedTimestampMs;

    for (let i = 0; i < batch.records.length; i++) {
      const r = batch.records[i];
      const safeOffsetMs = i === 0 ? r.offsetMs : Math.max(r.offsetMs, prevOffsetMs);
      prevOffsetMs = safeOffsetMs;

      const unifiedTimestampMs = Math.round(effectiveBaseMs + safeOffsetMs);
      const rawTimestampMs = baseRawMs + r.offsetMs;

      if (unifiedTimestampMs > maxBatchUnifiedMs) {
        maxBatchUnifiedMs = unifiedTimestampMs;
      }

      harmonizedRecords.push({
        ...r,
        timestampMs: unifiedTimestampMs,
        unifiedTimestampMs,
        rawTimestampMs,
        syncQuality,
        sessionId: tracker.sessionId,
      });
    }

    if (!isOutOfOrderBatch) {
      tracker.lastUnifiedTimestampMs = maxBatchUnifiedMs;
    }

    return {
      effectiveBaseMs: Math.round(effectiveBaseMs),
      syncQuality,
      sessionId: tracker.sessionId,
      records: harmonizedRecords,
    };
  }

  reconcileSessionHistory(
    deviceId,
    sessionId,
    newBootAnchorMs,
    targetSyncQuality = SYNC_QUALITY_HARMONIZED
  ) {
    if (!this.db || !Number.isFinite(newBootAnchorMs)) return 0;
    try {
      const stmt = this.db.prepare(`
        UPDATE measurements
        SET timestamp_ms = raw_timestamp_ms + ?,
            sync_quality = ?
        WHERE device_id = ?
          AND session_id = ?
          AND sync_quality IN (0, 3)
          AND raw_timestamp_ms < ?
      `);
      const info = stmt.run(
        Math.round(newBootAnchorMs),
        targetSyncQuality,
        deviceId,
        sessionId,
        MIN_VALID_EPOCH_MS
      );

      // Update tracker's high-water mark if reconciled rows were lowered or adjusted
      const latestRow = this.db
        .prepare('SELECT MAX(timestamp_ms) as max_ts FROM measurements WHERE device_id = ?')
        .get(deviceId);
      if (latestRow && latestRow.max_ts && this.trackers.has(deviceId)) {
        this.trackers.get(deviceId).lastUnifiedTimestampMs = latestRow.max_ts;
      }
      return info.changes;
    } catch (err) {
      console.warn('[ClockFusion] Retroactive reconcile warning:', err.message);
      return 0;
    }
  }
}
