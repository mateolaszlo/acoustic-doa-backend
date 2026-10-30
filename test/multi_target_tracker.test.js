import { describe, it, expect, beforeEach } from 'vitest';
import {
  MultiTargetTracker,
  wrapAngle180,
  TRACK_STATE_ACTIVE,
  TRACK_STATE_COASTING,
  TRACK_STATE_TENTATIVE,
} from '../utils/multi_target_tracker.js';

describe('MultiTargetTracker & Circular Kalman S1 Filter', () => {
  let tracker;

  beforeEach(() => {
    tracker = new MultiTargetTracker();
  });

  it('correctly wraps angles into [-180, +180)', () => {
    expect(wrapAngle180(0)).toBe(0);
    expect(wrapAngle180(180)).toBe(-180);
    expect(wrapAngle180(-180)).toBe(-180);
    expect(wrapAngle180(185)).toBe(-175);
    expect(wrapAngle180(-185)).toBe(175);
    expect(wrapAngle180(360)).toBe(0);
    expect(wrapAngle180(540)).toBe(-180);
  });

  it('1. Two simultaneous speakers 60 deg apart: maintains permanent Track IDs and display slots across amplitude flips', () => {
    const deviceId = 1;
    // Speaker A at -30 deg, Speaker B at +30 deg (60 deg apart)
    // Over 20 consecutive frames, Speaker A and Speaker B alternate who has higher confidence / SPL
    const baseTime = 1720000000000;

    for (let frame = 0; frame < 20; frame++) {
      const frameTs = baseTime + frame * 50; // 50ms frames
      const speakerAIsLouder = frame % 2 === 0;

      // CLEAN outputs up to 2 sources sorted by instantaneous confidence
      const detA = {
        offsetMs: 0,
        timestampMs: frameTs,
        angleDeg: -30.0 + (Math.sin(frame) * 1.5), // slight acoustic jitter
        delayUs: 0,
        soundLevelDb: speakerAIsLouder ? 75.0 : 62.0,
        confidence: speakerAIsLouder ? 0.90 : 0.60,
      };

      const detB = {
        offsetMs: 0,
        timestampMs: frameTs,
        angleDeg: 30.0 + (Math.cos(frame) * 1.5),
        delayUs: 0,
        soundLevelDb: speakerAIsLouder ? 62.0 : 75.0,
        confidence: speakerAIsLouder ? 0.60 : 0.90,
      };

      // Put higher confidence detection first as ESP32 CLEAN does
      const records = speakerAIsLouder ? [detA, detB] : [detB, detA];

      const batch = {
        header: { clockFlags: 1, baseTimestampMs: BigInt(frameTs), clockSource: 'SNTP_UTC' },
        records,
      };

      const result = tracker.processBatch(deviceId, batch);

      // Verify each record is assigned its proper persistent track
      for (const rec of result.records) {
        if (rec.angleDeg < 0) {
          // Speaker A: always trackId 1, slot 0
          expect(rec.trackId).toBe(1);
          expect(rec.trackSlot).toBe(0);
          expect(Math.abs(rec.smoothedAngleDeg - (-30.0))).toBeLessThanOrEqual(3.0);
        } else {
          // Speaker B: always trackId 2, slot 1
          expect(rec.trackId).toBe(2);
          expect(rec.trackSlot).toBe(1);
          expect(Math.abs(rec.smoothedAngleDeg - 30.0)).toBeLessThanOrEqual(3.0);
        }
      }

      // Check active tracks snapshot
      if (frame >= 2) {
        expect(result.activeTracks.length).toBe(2);
        const trackA = result.activeTracks.find((t) => t.trackId === 1);
        const trackB = result.activeTracks.find((t) => t.trackId === 2);
        expect(trackA).toBeDefined();
        expect(trackB).toBeDefined();
        expect(trackA.trackSlot).toBe(0);
        expect(trackB.trackSlot).toBe(1);
        expect(trackA.state).toBe(TRACK_STATE_ACTIVE);
        expect(trackB.state).toBe(TRACK_STATE_ACTIVE);
      }
    }
  });

  it('2. Alternating speech and syllabic coasting: retains track identity across 1.2s silence pauses', () => {
    const deviceId = 1;
    let t = 1720000000000;

    // Phase 1: Speaker A speaks alone at -45 deg for 300ms (6 frames)
    for (let i = 0; i < 6; i++) {
      t += 50;
      const batch = {
        header: { clockFlags: 1, baseTimestampMs: BigInt(t), clockSource: 'SNTP_UTC' },
        records: [{ offsetMs: 0, timestampMs: t, angleDeg: -45.0, delayUs: 0, soundLevelDb: 70, confidence: 0.85 }],
      };
      tracker.processBatch(deviceId, batch);
    }

    let activeTracks = tracker.getManager(deviceId).getActiveTracksSnapshot();
    expect(activeTracks.length).toBe(1);
    expect(activeTracks[0].trackId).toBe(1);
    expect(activeTracks[0].trackSlot).toBe(0);
    expect(activeTracks[0].state).toBe(TRACK_STATE_ACTIVE);

    // Phase 2: Speaker A pauses for 1200ms while Speaker B speaks at +75 deg for 600ms
    // Jump forward 200ms: Speaker A enters COASTING
    t += 200;
    for (let i = 0; i < 6; i++) {
      t += 50;
      const batch = {
        header: { clockFlags: 1, baseTimestampMs: BigInt(t), clockSource: 'SNTP_UTC' },
        records: [{ offsetMs: 0, timestampMs: t, angleDeg: 75.0, delayUs: 0, soundLevelDb: 72, confidence: 0.88 }],
      };
      tracker.processBatch(deviceId, batch);
    }

    activeTracks = tracker.getManager(deviceId).getActiveTracksSnapshot();
    expect(activeTracks.length).toBe(2);
    const speakerATrack = activeTracks.find((tr) => tr.trackId === 1);
    const speakerBTrack = activeTracks.find((tr) => tr.trackId === 2);

    expect(speakerATrack.state).toBe(TRACK_STATE_COASTING);
    expect(speakerATrack.trackSlot).toBe(0); // Holds slot 0!
    expect(speakerBTrack.state).toBe(TRACK_STATE_ACTIVE);
    expect(speakerBTrack.trackSlot).toBe(1); // Takes slot 1!

    // Phase 3: Speaker A speaks again after a total pause of 1.2s
    t += 500; // still within 2.5s coasting window
    const resumeBatch = {
      header: { clockFlags: 1, baseTimestampMs: BigInt(t), clockSource: 'SNTP_UTC' },
      records: [{ offsetMs: 0, timestampMs: t, angleDeg: -44.0, delayUs: 0, soundLevelDb: 71, confidence: 0.86 }],
    };
    const res = tracker.processBatch(deviceId, resumeBatch);

    // Speaker A must immediately resume with trackId = 1 and trackSlot = 0
    expect(res.records[0].trackId).toBe(1);
    expect(res.records[0].trackSlot).toBe(0);
    expect(res.records[0].trackState).toBe(TRACK_STATE_ACTIVE);

    const resumedTrack = tracker.getManager(deviceId).getActiveTracksSnapshot().find((tr) => tr.trackId === 1);
    expect(resumedTrack.state).toBe(TRACK_STATE_ACTIVE);
  });

  it('3. Geodesic circular tracking across +/-180 deg rear boundary: never jumps across 0 deg', () => {
    const deviceId = 1;
    let t = 1720000000000;

    // Moving sound source walking clockwise across back from +170 -> +178 -> -178 -> -170
    const azimuthTrajectory = [170.0, 174.0, 178.0, -178.0, -174.0, -170.0];

    let lastSmoothed = 170.0;
    for (const az of azimuthTrajectory) {
      t += 100;
      const batch = {
        header: { clockFlags: 1, baseTimestampMs: BigInt(t), clockSource: 'SNTP_UTC' },
        records: [{ offsetMs: 0, timestampMs: t, angleDeg: az, delayUs: 0, soundLevelDb: 68, confidence: 0.9 }],
      };
      const res = tracker.processBatch(deviceId, batch);
      const smoothed = res.records[0].smoothedAngleDeg;

      // Smoothed angle must always stay in the rear hemisphere (|angle| >= 160 deg)
      expect(Math.abs(smoothed)).toBeGreaterThan(160.0);
      lastSmoothed = smoothed;
    }

    const activeTracks = tracker.getManager(deviceId).getActiveTracksSnapshot();
    expect(activeTracks.length).toBe(1);
    expect(activeTracks[0].trackId).toBe(1);
    // Angular velocity across the rear boundary should be positive (moving clockwise)
    expect(activeTracks[0].velocityDegPerSec).toBeGreaterThan(0.0);
  });

  it('4. Single-speaker non-duplication: 10 consecutive frames never spawn false secondary or tertiary tracks', () => {
    const deviceId = 1;
    let t = 1720000000000;

    for (let i = 0; i < 10; i++) {
      t += 50;
      const batch = {
        header: { clockFlags: 1, baseTimestampMs: BigInt(t), clockSource: 'SNTP_UTC' },
        records: [{ offsetMs: 0, timestampMs: t, angleDeg: 45.0 + (i % 2 === 0 ? 1 : -1), delayUs: 0, soundLevelDb: 65, confidence: 0.8 }],
      };
      const res = tracker.processBatch(deviceId, batch);
      expect(res.records[0].trackId).toBe(1);
      expect(res.activeTracks.length).toBe(1);
    }
  });

  it('5. Clutter rejection & track expiration: tentative clutter expires after 600ms, confirmed track expires after 2500ms silence', () => {
    const deviceId = 1;
    let t = 1720000000000;

    // 1. Send single low-confidence noise blip (0.35 confidence)
    const clutterBatch = {
      header: { clockFlags: 1, baseTimestampMs: BigInt(t), clockSource: 'SNTP_UTC' },
      records: [{ offsetMs: 0, timestampMs: t, angleDeg: 120.0, delayUs: 0, soundLevelDb: 52, confidence: 0.35 }],
    };
    tracker.processBatch(deviceId, clutterBatch);

    const manager = tracker.getManager(deviceId);
    expect(manager.tracks.size).toBe(1);
    expect(Array.from(manager.tracks.values())[0].state).toBe(TRACK_STATE_TENTATIVE);
    expect(manager.getActiveTracksSnapshot().length).toBe(0); // Not active yet!

    // 700ms later with no follow-up: tentative track must be pruned
    t += 700;
    const dummyBatch = {
      header: { clockFlags: 1, baseTimestampMs: BigInt(t), clockSource: 'SNTP_UTC' },
      records: [],
    };
    tracker.processBatch(deviceId, dummyBatch);
    expect(manager.tracks.size).toBe(0);

    // 2. Establish confirmed active track with 2 hits
    t += 100;
    for (let i = 0; i < 2; i++) {
      t += 50;
      tracker.processBatch(deviceId, {
        header: { clockFlags: 1, baseTimestampMs: BigInt(t), clockSource: 'SNTP_UTC' },
        records: [{ offsetMs: 0, timestampMs: t, angleDeg: -60.0, delayUs: 0, soundLevelDb: 68, confidence: 0.85 }],
      });
    }
    expect(manager.getActiveTracksSnapshot().length).toBe(1);

    // Advance by 2600ms of silence: confirmed track must expire and free its slot
    t += 2600;
    tracker.processBatch(deviceId, {
      header: { clockFlags: 1, baseTimestampMs: BigInt(t), clockSource: 'SNTP_UTC' },
      records: [],
    });
    expect(manager.tracks.size).toBe(0);
    expect(manager.getActiveTracksSnapshot().length).toBe(0);
    expect(manager.slotAssignments[0]).toBeNull();
  });
});
