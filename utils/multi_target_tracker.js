/**
 * Temporal Multi-Target Tracking (MTT) Engine
 *
 * Implements:
 * 1. Circular Kalman Filter on S1 ([-180, +180) degrees) with angular velocity tracking.
 * 2. GNN (Global Nearest Neighbor) Mahalanobis data association across multi-source CLEAN frames.
 * 3. Speech-aware track lifecycle (TENTATIVE -> ACTIVE -> COASTING -> DELETED).
 * 4. Stable display slot assignment (Slot 0 = Emerald, Slot 1 = Indigo, Slot 2 = Sky-Blue).
 */

export const TRACK_STATE_TENTATIVE = 'TENTATIVE';
export const TRACK_STATE_ACTIVE = 'ACTIVE';
export const TRACK_STATE_COASTING = 'COASTING';
export const TRACK_STATE_DELETED = 'DELETED';

export const GATE_MAX_ANGLE_DEG = 25.0; // Aligned with firmware DOA_MIN_SOURCE_SEPARATION_DEG
export const GATE_MAHALANOBIS_CHI2 = 16.0; // 4-sigma gating threshold
export const TENTATIVE_MAX_AGE_MS = 600; // Tentative tracks must confirm within 600ms
export const COAST_TIMEOUT_MS = 2500; // Hold coasting tracks for up to 2.5s between words/sentences
export const COASTING_MIN_SILENCE_MS = 150; // Mark coasting after 150ms without detection

/**
 * Geodesically wraps an angle in degrees into [-180.0, +180.0)
 */
export function wrapAngle180(deg) {
  let a = (deg + 180) % 360;
  if (a < 0) a += 360;
  return a - 180;
}

export class AcousticTrack {
  constructor(id, initialDetection, timestampMs) {
    this.id = id;
    this.state = TRACK_STATE_TENTATIVE;
    this.slot = null; // Assigned when confirmed (0, 1, or 2)

    // State vector on S1: [azimuth_deg, angular_velocity_deg_per_sec]
    this.theta = wrapAngle180(initialDetection.angleDeg);
    this.omega = 0.0;

    // Error covariance matrix P (2x2)
    this.P = [
      [16.0, 0.0],
      [0.0, 25.0],
    ];

    this.firstSeenMs = timestampMs;
    this.lastHitMs = timestampMs;
    this.lastPredictMs = timestampMs;
    this.hits = 1;
    this.misses = 0;

    // Running smoothed acoustics
    this.soundLevelDb = initialDetection.soundLevelDb;
    this.confidence = initialDetection.confidence;
    this.latestRawAngleDeg = initialDetection.angleDeg;
  }

  predict(timestampMs) {
    const dt = Math.max(0, (timestampMs - this.lastPredictMs) / 1000.0);
    this.lastPredictMs = timestampMs;
    if (dt <= 0) return;

    // Angular velocity damping over speech pauses (half-life ~ 1.5 seconds)
    const gamma = Math.exp(-dt / 1.5);

    // S1 circular extrapolation
    this.theta = wrapAngle180(this.theta + this.omega * dt);
    this.omega = this.omega * gamma;

    // F matrix = [[1, dt], [0, gamma]]
    // Process noise covariance Q(dt)
    const qa = 4.0; // deg/s^2 acceleration noise
    const q00 = qa * qa * ((1.0 / 3.0) * dt * dt * dt + 1.0 * dt);
    const q01 = qa * qa * (0.5 * dt * dt);
    const q11 = qa * qa * dt;

    // P_pred = F * P * F^T + Q
    const p00 = this.P[0][0];
    const p01 = this.P[0][1];
    const p10 = this.P[1][0];
    const p11 = this.P[1][1];

    const fP00 = p00 + dt * p10;
    const fP01 = p01 + dt * p11;
    const fP10 = gamma * p10;
    const fP11 = gamma * p11;

    this.P[0][0] = fP00 + dt * fP01 + q00;
    this.P[0][1] = fP01 * gamma + q01;
    this.P[1][0] = this.P[0][1];
    this.P[1][1] = gamma * fP11 + q11;
  }

  update(detection, timestampMs) {
    const rawZ = detection.angleDeg;
    const conf = Math.max(0.15, detection.confidence || 0.5);

    // Adaptive measurement noise: R = sigma0^2 / conf^2 (sigma0 = 3.5 deg)
    const sigma0 = 3.5;
    const R = (sigma0 * sigma0) / (conf * conf);

    // Geodesic innovation on S1
    const y = wrapAngle180(rawZ - this.theta);

    // Innovation covariance S = P_00 + R
    const S = this.P[0][0] + R;
    const K0 = this.P[0][0] / S;
    const K1 = this.P[1][0] / S;

    // State update
    this.theta = wrapAngle180(this.theta + K0 * y);
    this.omega = Math.max(-90.0, Math.min(90.0, this.omega + K1 * y));

    // Joseph-form covariance update
    const p00 = this.P[0][0];
    const p01 = this.P[0][1];
    const p10 = this.P[1][0];
    const p11 = this.P[1][1];

    this.P[0][0] = (1.0 - K0) * p00;
    this.P[0][1] = (1.0 - K0) * p01;
    this.P[1][0] = p10 - K1 * p00;
    this.P[1][1] = p11 - K1 * p01;
    const sym = 0.5 * (this.P[0][1] + this.P[1][0]);
    this.P[0][1] = sym;
    this.P[1][0] = sym;

    // Exponential smoothing of level and confidence
    this.soundLevelDb = 0.65 * detection.soundLevelDb + 0.35 * this.soundLevelDb;
    this.confidence = 0.65 * detection.confidence + 0.35 * this.confidence;
    this.latestRawAngleDeg = rawZ;

    this.hits++;
    this.lastHitMs = timestampMs;
    this.misses = 0;
  }
}

export class DeviceTrackManager {
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.nextTrackId = 1;
    this.tracks = new Map(); // trackId -> AcousticTrack
    this.slotAssignments = [null, null, null]; // slot 0, 1, 2 -> trackId
    this.lastFrameTimestampMs = 0;
  }

  reset() {
    this.tracks.clear();
    this.slotAssignments = [null, null, null];
    this.nextTrackId = 1;
    this.lastFrameTimestampMs = 0;
  }

  _acquireSlot(trackId) {
    for (let slot = 0; slot < 3; slot++) {
      if (this.slotAssignments[slot] === null || this.slotAssignments[slot] === trackId) {
        this.slotAssignments[slot] = trackId;
        return slot;
      }
    }
    // Fallback if all 3 slots occupied: replace slot with oldest coasting track
    let oldestCoastSlot = 2;
    let oldestTime = Infinity;
    for (let slot = 0; slot < 3; slot++) {
      const tid = this.slotAssignments[slot];
      const t = this.tracks.get(tid);
      if (t && t.state === TRACK_STATE_COASTING && t.lastHitMs < oldestTime) {
        oldestTime = t.lastHitMs;
        oldestCoastSlot = slot;
      }
    }
    const victimTid = this.slotAssignments[oldestCoastSlot];
    if (victimTid && this.tracks.has(victimTid)) {
      this.tracks.get(victimTid).slot = null;
    }
    this.slotAssignments[oldestCoastSlot] = trackId;
    return oldestCoastSlot;
  }

  _releaseSlot(slot, trackId) {
    if (slot !== null && slot >= 0 && slot < 3 && this.slotAssignments[slot] === trackId) {
      this.slotAssignments[slot] = null;
    }
  }

  processFrame(timestampMs, detections) {
    this.lastFrameTimestampMs = timestampMs;

    // 1. Predict all existing tracks to timestampMs
    for (const track of this.tracks.values()) {
      track.predict(timestampMs);
    }

    const trackList = Array.from(this.tracks.values());
    const matchedTrackIds = new Set();
    const matchedDetectionIndices = new Set();
    const assignmentPairs = [];

    // 2. Build cost matrix for GNN assignment
    // Rows = tracks, Cols = detections
    const candidates = [];
    for (let tIdx = 0; tIdx < trackList.length; tIdx++) {
      const track = trackList[tIdx];
      for (let dIdx = 0; dIdx < detections.length; dIdx++) {
        const det = detections[dIdx];
        const y = Math.abs(wrapAngle180(det.angleDeg - track.theta));
        if (y > GATE_MAX_ANGLE_DEG) continue; // Hard angular gate

        const conf = Math.max(0.15, det.confidence || 0.5);
        const R = (3.5 * 3.5) / (conf * conf);
        const S = track.P[0][0] + R;
        const d2 = (y * y) / S;
        if (d2 > GATE_MAHALANOBIS_CHI2) continue; // Mahalanobis gate

        // Cost with state-dependent bias: favor established tracks
        let cost = d2;
        if (track.state === TRACK_STATE_ACTIVE) cost -= 2.0;
        else if (track.state === TRACK_STATE_COASTING) cost -= 1.0;

        candidates.push({ tIdx, dIdx, trackId: track.id, cost, y });
      }
    }

    // Sort candidate associations by ascending cost (greedy optimal 1-to-1 match)
    candidates.sort((a, b) => a.cost - b.cost);

    for (const c of candidates) {
      if (matchedTrackIds.has(c.trackId) || matchedDetectionIndices.has(c.dIdx)) {
        continue;
      }
      matchedTrackIds.add(c.trackId);
      matchedDetectionIndices.add(c.dIdx);
      assignmentPairs.push({
        track: trackList[c.tIdx],
        detectionIndex: c.dIdx,
        detection: detections[c.dIdx],
      });
    }

    // 3. Update matched tracks
    for (const pair of assignmentPairs) {
      const track = pair.track;
      track.update(pair.detection, timestampMs);

      // Confirm tentative track on 2 hits or high-confidence single hit
      if (track.state === TRACK_STATE_TENTATIVE) {
        if (track.hits >= 2 || pair.detection.confidence >= 0.7) {
          track.state = TRACK_STATE_ACTIVE;
          track.slot = this._acquireSlot(track.id);
        }
      } else if (track.state === TRACK_STATE_COASTING) {
        track.state = TRACK_STATE_ACTIVE;
        if (track.slot === null) {
          track.slot = this._acquireSlot(track.id);
        }
      }
    }

    // 4. Create new TENTATIVE tracks for unmatched detections
    for (let dIdx = 0; dIdx < detections.length; dIdx++) {
      if (matchedDetectionIndices.has(dIdx)) continue;
      const det = detections[dIdx];

      // Avoid creating track if detection is right on top of an existing active track
      let tooClose = false;
      for (const t of this.tracks.values()) {
        if (Math.abs(wrapAngle180(det.angleDeg - t.theta)) < 15.0) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        const newTrackId = this.nextTrackId++;
        const newTrack = new AcousticTrack(newTrackId, det, timestampMs);
        newTrack.slot = this._acquireSlot(newTrack.id);
        if (det.confidence >= 0.70) {
          newTrack.state = TRACK_STATE_ACTIVE;
        }
        this.tracks.set(newTrackId, newTrack);
        assignmentPairs.push({
          track: newTrack,
          detectionIndex: dIdx,
          detection: det,
        });
      }
    }

    // 5. Lifecycle evaluation & pruning of unmatched tracks
    for (const track of Array.from(this.tracks.values())) {
      const silenceMs = timestampMs - track.lastHitMs;

      if (track.state === TRACK_STATE_TENTATIVE) {
        if (silenceMs > TENTATIVE_MAX_AGE_MS) {
          this._releaseSlot(track.slot, track.id);
          this.tracks.delete(track.id);
        }
      } else if (track.state === TRACK_STATE_ACTIVE) {
        if (silenceMs > COAST_TIMEOUT_MS) {
          this._releaseSlot(track.slot, track.id);
          this.tracks.delete(track.id);
        } else if (silenceMs >= COASTING_MIN_SILENCE_MS) {
          track.state = TRACK_STATE_COASTING;
        }
      } else if (track.state === TRACK_STATE_COASTING) {
        if (silenceMs > COAST_TIMEOUT_MS) {
          this._releaseSlot(track.slot, track.id);
          this.tracks.delete(track.id);
        }
      }
    }

    // 6. Return mapped records with track metadata
    const annotatedDetections = detections.map((det, idx) => {
      const match = assignmentPairs.find((p) => p.detectionIndex === idx);
      const track = match ? match.track : null;
      return {
        ...det,
        trackId: track ? track.id : null,
        trackSlot: track && track.slot !== null ? track.slot : 0,
        trackState: track ? track.state : TRACK_STATE_TENTATIVE,
        smoothedAngleDeg: track ? Number(track.theta.toFixed(1)) : det.angleDeg,
        angularVelocityDegPerSec: track ? Number(track.omega.toFixed(1)) : 0.0,
      };
    });

    return annotatedDetections;
  }

  getActiveTracksSnapshot() {
    const result = [];
    for (const t of this.tracks.values()) {
      if (t.state === TRACK_STATE_ACTIVE || t.state === TRACK_STATE_COASTING) {
        result.push({
          trackId: t.id,
          trackSlot: t.slot !== null ? t.slot : 0,
          state: t.state,
          angleDeg: Number(t.theta.toFixed(1)),
          rawAngleDeg: Number(t.latestRawAngleDeg.toFixed(1)),
          velocityDegPerSec: Number(t.omega.toFixed(1)),
          soundLevelDb: Number(t.soundLevelDb.toFixed(1)),
          confidence: Number(t.confidence.toFixed(2)),
          hits: t.hits,
          lastUpdatedMs: t.lastHitMs,
          ageMs: this.lastFrameTimestampMs - t.firstSeenMs,
        });
      }
    }
    // Sort tracks by slot ascending (Slot 0 Primary, Slot 1 Secondary, Slot 2 Tertiary)
    result.sort((a, b) => a.trackSlot - b.trackSlot);
    return result;
  }
}

export class MultiTargetTracker {
  constructor() {
    this.deviceManagers = new Map(); // deviceId -> DeviceTrackManager
  }

  getManager(deviceId) {
    if (!this.deviceManagers.has(deviceId)) {
      this.deviceManagers.set(deviceId, new DeviceTrackManager(deviceId));
    }
    return this.deviceManagers.get(deviceId);
  }

  resetDevice(deviceId) {
    if (this.deviceManagers.has(deviceId)) {
      this.deviceManagers.get(deviceId).reset();
    }
  }

  processBatch(deviceId, fusedBatch) {
    const manager = this.getManager(deviceId);

    if (!fusedBatch.records || fusedBatch.records.length === 0) {
      const ts = Number(fusedBatch.header?.baseTimestampMs || Date.now());
      manager.processFrame(ts, []);
      return {
        header: fusedBatch.header,
        records: [],
        activeTracks: manager.getActiveTracksSnapshot(),
      };
    }

    // 1. Group records by exact timestampMs (each distinct timestamp = 1 FFT frame)
    const frameMap = new Map();
    for (const r of fusedBatch.records) {
      const ts = r.timestampMs;
      if (!frameMap.has(ts)) {
        frameMap.set(ts, []);
      }
      frameMap.get(ts).push(r);
    }

    // 2. Process frames in chronological ascending order
    const sortedTimestamps = Array.from(frameMap.keys()).sort((a, b) => a - b);
    const trackedRecordsMap = new Map();

    for (const ts of sortedTimestamps) {
      const frameDetections = frameMap.get(ts);
      const annotated = manager.processFrame(ts, frameDetections);
      trackedRecordsMap.set(ts, annotated);
    }

    // 3. Reconstruct records preserving original batch record order
    const finalRecords = [];
    const indexPointers = new Map();

    for (const r of fusedBatch.records) {
      const ts = r.timestampMs;
      const idx = indexPointers.get(ts) || 0;
      const annotatedList = trackedRecordsMap.get(ts) || [];
      const item = annotatedList[idx] || r;
      indexPointers.set(ts, idx + 1);
      finalRecords.push(item);
    }

    const activeTracks = manager.getActiveTracksSnapshot();

    return {
      header: fusedBatch.header,
      records: finalRecords,
      activeTracks,
    };
  }
}
