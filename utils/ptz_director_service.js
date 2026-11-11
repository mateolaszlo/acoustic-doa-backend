/**
 * Authoritative PTZ Director & Studio Configuration Service
 *
 * Implements:
 * 1. Persistent Conference Room Layout (table shape, dimensions, custom chairs).
 * 2. Virtual Camera Studio placements & roles.
 * 3. Schmitt-Trigger Automated PTZ Director Engine operating in canonical 850x470 room coordinates.
 * 4. Perspective & proximity camera scoring with sticky subject memory.
 */

export const BASE_ROOM_WIDTH = 850;
export const BASE_ROOM_HEIGHT = 470;
export const BASE_ROOM_CENTER_X = 425; // 850 / 2
export const BASE_ROOM_CENTER_Y = 245; // 470 / 2 + 10

export const DEFAULT_ROOM_LAYOUT = {
  tableShape: 'oval',
  tableWidthRatio: 0.52,
  tableHeightRatio: 0.32,
  seatCount: 8,
};

export const DEFAULT_VIRTUAL_CAMERAS = [
  {
    id: 'cam-front',
    name: 'Stage Front Cam',
    xRatio: 0.5,
    yRatio: 0.08,
    restingPanDeg: 180.0, // Looks South across table at audience
    currentPanDeg: 180.0,
    targetPanDeg: 180.0,
    fovDeg: 60.0,
    color: '#10b981',
    isLive: true,
    role: 'front',
    assignedTargetSlot: null,
    isLockedOnSubject: false,
    lastTargetPos: null,
  },
  {
    id: 'cam-rear',
    name: 'Audience Rear Cam',
    xRatio: 0.5,
    yRatio: 0.92,
    restingPanDeg: 0.0, // Looks North at podium / presenter
    currentPanDeg: 0.0,
    targetPanDeg: 0.0,
    fovDeg: 60.0,
    color: '#38bdf8',
    isLive: false,
    role: 'rear',
    assignedTargetSlot: null,
    isLockedOnSubject: false,
    lastTargetPos: null,
  },
  {
    id: 'cam-side',
    name: 'Side Profile Cam',
    xRatio: 0.08,
    yRatio: 0.5,
    restingPanDeg: 90.0, // Looks East across table
    currentPanDeg: 90.0,
    targetPanDeg: 90.0,
    fovDeg: 60.0,
    color: '#818cf8',
    isLive: false,
    role: 'side',
    assignedTargetSlot: null,
    isLockedOnSubject: false,
    lastTargetPos: null,
  },
];

export const DEFAULT_DIRECTOR_CONFIG = {
  slewSpeedDegPerSec: 120.0,
  instantCut: false,
  holdTimeMs: 1800,
  confirmTimeMs: 350,
  hysteresisMarginPercent: 20,
};

/**
 * Normalizes an angle into [-180, 180) degrees.
 */
export function wrapAngle180(deg) {
  let a = (deg + 180) % 360;
  if (a < 0) a += 360;
  return a - 180;
}

/**
 * Returns shortest angular difference from current to target in [-180, 180) degrees.
 */
export function shortestAngleDiff(targetDeg, currentDeg) {
  return wrapAngle180(targetDeg - currentDeg);
}

/**
 * Computes default symmetrical chair positions around the conference table
 * for a given room layout configuration and room dimensions.
 */
export function computeDefaultChairs(layout, roomWidth = BASE_ROOM_WIDTH, roomHeight = BASE_ROOM_HEIGHT) {
  const centerX = roomWidth / 2;
  const centerY = roomHeight / 2 + 10;
  const tableW = roomWidth * layout.tableWidthRatio;
  const tableH = roomHeight * layout.tableHeightRatio;
  const tableX = centerX - tableW / 2;
  const tableY = centerY - tableH / 2;
  const totalSeats = Math.max(2, layout.seatCount || 8);
  const chairs = [];

  if (layout.tableShape === 'round') {
    const r = Math.min(tableW, tableH) * 0.48;
    for (let i = 0; i < totalSeats; i++) {
      const ang = (i / totalSeats) * Math.PI * 2 - Math.PI / 2;
      const px = centerX + Math.cos(ang) * (r + 14);
      const py = centerY + Math.sin(ang) * (r + 14);
      chairs.push({
        id: `chair-${i}`,
        xRatio: Math.max(0.04, Math.min(0.96, px / roomWidth)),
        yRatio: Math.max(0.04, Math.min(0.96, py / roomHeight)),
      });
    }
    return chairs;
  }

  if (layout.tableShape === 'ushape') {
    const sideSeats = Math.max(1, Math.floor(totalSeats * 0.35));
    const bottomSeats = Math.max(1, totalSeats - sideSeats * 2);
    let idCounter = 0;

    // Left wing
    for (let i = 0; i < sideSeats; i++) {
      const cy = tableY + 24 + (i / Math.max(1, sideSeats - 1)) * (tableH - 48);
      chairs.push({
        id: `chair-${idCounter++}`,
        xRatio: (tableX - 14) / roomWidth,
        yRatio: cy / roomHeight,
      });
    }
    // Right wing
    for (let i = 0; i < sideSeats; i++) {
      const cy = tableY + 24 + (i / Math.max(1, sideSeats - 1)) * (tableH - 48);
      chairs.push({
        id: `chair-${idCounter++}`,
        xRatio: (tableX + tableW + 14) / roomWidth,
        yRatio: cy / roomHeight,
      });
    }
    // Bottom wing
    for (let i = 0; i < bottomSeats; i++) {
      const cx = tableX + 32 + (i / Math.max(1, bottomSeats - 1)) * (tableW - 64);
      chairs.push({
        id: `chair-${idCounter++}`,
        xRatio: cx / roomWidth,
        yRatio: (tableY + tableH + 14) / roomHeight,
      });
    }
    return chairs;
  }

  if (layout.tableShape === 'hollow_square') {
    if (totalSeats <= 4) {
      const defaultPositions = [
        { x: centerX, y: tableY - 14 },
        { x: tableX + tableW + 14, y: centerY },
        { x: centerX, y: tableY + tableH + 14 },
        { x: tableX - 14, y: centerY },
      ];
      for (let i = 0; i < totalSeats; i++) {
        chairs.push({
          id: `chair-${i}`,
          xRatio: defaultPositions[i].x / roomWidth,
          yRatio: defaultPositions[i].y / roomHeight,
        });
      }
      return chairs;
    }

    const perSide = Math.max(1, Math.floor(totalSeats / 4));
    let idCounter = 0;
    // North edge
    for (let i = 0; i < perSide; i++) {
      const t = perSide > 1 ? i / (perSide - 1) : 0.5;
      const cx = tableX + 32 + t * (tableW - 64);
      chairs.push({ id: `chair-${idCounter++}`, xRatio: cx / roomWidth, yRatio: (tableY - 14) / roomHeight });
    }
    // East edge
    for (let i = 0; i < perSide; i++) {
      const t = perSide > 1 ? i / (perSide - 1) : 0.5;
      const cy = tableY + 32 + t * (tableH - 64);
      chairs.push({ id: `chair-${idCounter++}`, xRatio: (tableX + tableW + 14) / roomWidth, yRatio: cy / roomHeight });
    }
    // South edge
    for (let i = 0; i < perSide; i++) {
      const t = perSide > 1 ? i / (perSide - 1) : 0.5;
      const cx = tableX + 32 + t * (tableW - 64);
      chairs.push({ id: `chair-${idCounter++}`, xRatio: cx / roomWidth, yRatio: (tableY + tableH + 14) / roomHeight });
    }
    // West edge
    for (let i = 0; i < perSide; i++) {
      const t = perSide > 1 ? i / (perSide - 1) : 0.5;
      const cy = tableY + 32 + t * (tableH - 64);
      chairs.push({ id: `chair-${idCounter++}`, xRatio: (tableX - 14) / roomWidth, yRatio: cy / roomHeight });
    }
    return chairs;
  }

  // Oval / Default
  if (totalSeats === 2) {
    chairs.push({
      id: 'chair-0',
      xRatio: centerX / roomWidth,
      yRatio: (tableY - 14) / roomHeight,
    });
    chairs.push({
      id: 'chair-1',
      xRatio: centerX / roomWidth,
      yRatio: (tableY + tableH + 14) / roomHeight,
    });
    return chairs;
  }

  if (totalSeats <= 4) {
    const pts = [
      { x: centerX, y: tableY - 14 },
      { x: tableX + tableW + 14, y: centerY },
      { x: centerX, y: tableY + tableH + 14 },
      { x: tableX - 14, y: centerY },
    ];
    for (let i = 0; i < totalSeats; i++) {
      chairs.push({
        id: `chair-${i}`,
        xRatio: pts[i].x / roomWidth,
        yRatio: pts[i].y / roomHeight,
      });
    }
    return chairs;
  }

  // totalSeats > 4 for Oval
  chairs.push({
    id: 'chair-0',
    xRatio: (tableX - 14) / roomWidth,
    yRatio: centerY / roomHeight,
  });
  chairs.push({
    id: 'chair-1',
    xRatio: (tableX + tableW + 14) / roomWidth,
    yRatio: centerY / roomHeight,
  });

  const remaining = totalSeats - 2;
  const perSide = Math.floor(remaining / 2);
  let idCount = 2;
  for (let i = 0; i < perSide; i++) {
    const t = perSide > 1 ? i / (perSide - 1) : 0.5;
    const cx = tableX + 36 + t * (tableW - 72);
    chairs.push({
      id: `chair-${idCount++}`,
      xRatio: cx / roomWidth,
      yRatio: (tableY - 14) / roomHeight,
    });
    chairs.push({
      id: `chair-${idCount++}`,
      xRatio: cx / roomWidth,
      yRatio: (tableY + tableH + 14) / roomHeight,
    });
  }

  return chairs;
}

/**
 * Computes shape-aware 2D world coordinates for a speaker seated at angleDeg
 * relative to the conference table geometry and room dimensions.
 */
export function calculateTablePerimeterPos(
  centerX = BASE_ROOM_CENTER_X,
  centerY = BASE_ROOM_CENTER_Y,
  angleDeg = 0,
  layout = DEFAULT_ROOM_LAYOUT,
  roomWidth = BASE_ROOM_WIDTH,
  roomHeight = BASE_ROOM_HEIGHT
) {
  const normAngle = wrapAngle180(angleDeg);
  const rad = (normAngle * Math.PI) / 180.0;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);

  const tableW = roomWidth * layout.tableWidthRatio;
  const tableH = roomHeight * layout.tableHeightRatio;
  const halfW = tableW / 2;
  const halfH = tableH / 2;

  // 1. If custom chairs exist, snap to chair coordinate if within 25°
  if (layout.customChairs && layout.customChairs.length > 0) {
    let closestChairPos = null;
    let minDiff = 25.0;

    for (const chair of layout.customChairs) {
      const chairPxX = centerX + (chair.xRatio - 0.5) * roomWidth;
      const chairPxY = centerY + chair.yRatio * roomHeight - BASE_ROOM_CENTER_Y;
      const dx = chairPxX - centerX;
      const dy = chairPxY - centerY;
      const chairAngle = wrapAngle180((Math.atan2(dx, -dy) * 180) / Math.PI);
      const diff = Math.abs(shortestAngleDiff(normAngle, chairAngle));
      if (diff < minDiff) {
        minDiff = diff;
        closestChairPos = { x: chairPxX, y: chairPxY };
      }
    }

    if (closestChairPos) {
      return closestChairPos;
    }
  }

  // 2. Round Table: circular boundary
  if (layout.tableShape === 'round') {
    const r = Math.min(halfW, halfH) * 0.95;
    return {
      x: centerX + r * sin,
      y: centerY - r * cos,
    };
  }

  // 3. U-Shape Table: outer and inner desk arms
  if (layout.tableShape === 'ushape') {
    const deskThick = Math.max(34, Math.min(tableW * 0.22, tableH * 0.32));
    const leftDeskCenterX = centerX - halfW + deskThick / 2;
    const rightDeskCenterX = centerX + halfW - deskThick / 2;
    const bottomDeskCenterY = centerY + halfH - deskThick / 2;

    // North presenter / podium zone (-40° to +40°)
    if (Math.abs(normAngle) <= 40) {
      const podiumDist = Math.max(halfH * 0.95, 60);
      return {
        x: centerX + podiumDist * sin * 0.7,
        y: centerY - podiumDist,
      };
    }

    // West wing: Left desk arm (-140° to -40°)
    if (normAngle > -140 && normAngle < -40) {
      const t = (normAngle - (-40)) / (-140 - (-40));
      const y = centerY - halfH + 20 + t * (tableH - 40);
      return {
        x: leftDeskCenterX,
        y,
      };
    }

    // East wing: Right desk arm (+40° to +140°)
    if (normAngle >= 40 && normAngle <= 140) {
      const t = (normAngle - 40) / (140 - 40);
      const y = centerY - halfH + 20 + t * (tableH - 40);
      return {
        x: rightDeskCenterX,
        y,
      };
    }

    // South wing: Bottom desk arm
    let t = 0.5;
    if (normAngle > 0) {
      t = 0.5 + ((normAngle - 140) / 40) * 0.35;
    } else {
      t = 0.15 + ((normAngle - (-180)) / 40) * 0.35;
    }
    const x = centerX - halfW + t * tableW;
    return {
      x,
      y: bottomDeskCenterY,
    };
  }

  // 4. Exact Ray-Box Table Perimeter Intersection for Oval & Square
  const absSin = Math.abs(sin) || 0.0001;
  const absCos = Math.abs(cos) || 0.0001;
  const t = Math.min(halfW / absSin, halfH / absCos);

  return {
    x: centerX + t * sin * 0.95,
    y: centerY - t * cos * 0.95,
  };
}

/**
 * Computes exact camera bearing angle needed for a camera at (camX, camY)
 * to aim directly at a target at (targetX, targetY).
 */
export function calculateCameraBearing(camX, camY, targetX, targetY) {
  const dx = targetX - camX;
  const dy = targetY - camY;

  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
    return 0.0;
  }

  // Convention: 0° is North (-Y), +90° is East (+X)
  const angleRad = Math.atan2(dx, -dy);
  return wrapAngle180((angleRad * 180.0) / Math.PI);
}

/**
 * Scores a camera's suitability for framing an active speaker.
 */
export function scoreCameraCandidate(
  cam,
  speakerPos,
  speakerAngleDeg,
  roomWidth = BASE_ROOM_WIDTH,
  roomHeight = BASE_ROOM_HEIGHT
) {
  const camX = cam.xRatio * roomWidth;
  const camY = cam.yRatio * roomHeight;

  // 1. Distance score
  const dist = Math.hypot(speakerPos.x - camX, speakerPos.y - camY);
  const maxDist = Math.hypot(roomWidth, roomHeight);
  const distScore = 40.0 * (1.0 - Math.min(1.0, dist / maxDist));

  // 2. Perspective / Facing score
  const normAngle = wrapAngle180(speakerAngleDeg);
  const isPodium = normAngle >= -35.0 && normAngle <= 35.0;
  let facingScore = 10.0;

  if (isPodium) {
    if (cam.role === 'rear') facingScore = 60.0;
    else if (cam.role === 'side') facingScore = 30.0;
    else facingScore = 5.0;
  } else {
    if (cam.role === 'front') facingScore = 60.0;
    else if (cam.role === 'side') facingScore = 35.0;
    else facingScore = 5.0;
  }

  // Side camera bonus for cross-table angles
  if (cam.role === 'side' && Math.abs(normAngle) > 60.0 && Math.abs(normAngle) < 140.0) {
    facingScore += 15.0;
  }

  return facingScore + distScore;
}

/**
 * Resolves which spatial room zone an acoustic arrival belongs to.
 */
export function resolveSpatialZone(angleDeg, zones) {
  if (!zones || zones.length === 0) return null;
  const norm = wrapAngle180(angleDeg);

  for (const zone of zones) {
    if (zone.min_angle_deg <= zone.max_angle_deg) {
      if (norm >= zone.min_angle_deg && norm <= zone.max_angle_deg) {
        return zone;
      }
    } else {
      // Circular wrap-around sector crossing +-180° South seam
      if (norm >= zone.min_angle_deg || norm <= zone.max_angle_deg) {
        return zone;
      }
    }
  }
  return null;
}

export class PTZDirectorService {
  constructor(db) {
    this.db = db;
    this.deviceStates = new Map(); // deviceId -> DirectorRuntimeState
  }

  _getOrCreateDeviceRuntimeState(deviceId) {
    if (!this.deviceStates.has(deviceId)) {
      this.deviceStates.set(deviceId, {
        lastSwitchTimeMs: Date.now(),
        candidateCamId: null,
        candidateStartTimeMs: 0,
        lastRoomAudioTimeMs: Date.now(),
        liveCamId: 'cam-front',
        activeZoneName: 'None',
        cameras: JSON.parse(JSON.stringify(DEFAULT_VIRTUAL_CAMERAS)),
      });
    }
    return this.deviceStates.get(deviceId);
  }

  resetDevice(deviceId) {
    if (this.deviceStates.has(deviceId)) {
      this.deviceStates.delete(deviceId);
    }
  }

  /**
   * Retrieves persisted studio config from SQLite, initializing defaults if needed.
   */
  getStudioConfig(deviceId) {
    let row = this.db.prepare('SELECT * FROM device_studio_config WHERE device_id = ?').get(deviceId);

    if (!row) {
      const now = new Date().toISOString();
      const insertStmt = this.db.prepare(`
        INSERT INTO device_studio_config (
          device_id, room_layout_json, cameras_json, director_config_json, live_cam_id, updated_at
        ) VALUES (?, ?, ?, ?, 'cam-front', ?)
      `);

      insertStmt.run(
        deviceId,
        JSON.stringify(DEFAULT_ROOM_LAYOUT),
        JSON.stringify(DEFAULT_VIRTUAL_CAMERAS),
        JSON.stringify(DEFAULT_DIRECTOR_CONFIG),
        now
      );

      row = this.db.prepare('SELECT * FROM device_studio_config WHERE device_id = ?').get(deviceId);
    }

    const roomLayout = JSON.parse(row.room_layout_json);
    const storedCameras = JSON.parse(row.cameras_json);
    const directorConfig = JSON.parse(row.director_config_json);
    const runtime = this._getOrCreateDeviceRuntimeState(deviceId);

    // Merge runtime live state into cameras
    const mergedCameras = storedCameras.map((storedCam) => {
      const rtCam = runtime.cameras.find((c) => c.id === storedCam.id);
      return {
        ...storedCam,
        isLive: storedCam.id === (runtime.liveCamId || row.live_cam_id),
        targetPanDeg: rtCam ? rtCam.targetPanDeg : storedCam.restingPanDeg,
        currentPanDeg: rtCam ? rtCam.currentPanDeg : storedCam.restingPanDeg,
        assignedTargetSlot: rtCam ? rtCam.assignedTargetSlot : null,
        isLockedOnSubject: rtCam ? rtCam.isLockedOnSubject : false,
        lastTargetPos: rtCam ? rtCam.lastTargetPos : null,
      };
    });

    return {
      deviceId,
      roomLayout,
      cameras: mergedCameras,
      directorConfig,
      liveCamId: runtime.liveCamId || row.live_cam_id,
      activeZoneName: runtime.activeZoneName || 'None',
      updatedAt: row.updated_at,
    };
  }

  /**
   * Updates studio layout, virtual cameras, director config, and/or live camera manual override.
   */
  updateStudioConfig(deviceId, payload = {}) {
    const current = this.getStudioConfig(deviceId);
    const now = new Date().toISOString();

    let newLayout = current.roomLayout;
    let newCameras = current.cameras;
    let newDirectorConfig = current.directorConfig;
    let newLiveCamId = current.liveCamId;

    if (payload.reset) {
      newLayout = JSON.parse(JSON.stringify(DEFAULT_ROOM_LAYOUT));
      newCameras = JSON.parse(JSON.stringify(DEFAULT_VIRTUAL_CAMERAS));
      newDirectorConfig = JSON.parse(JSON.stringify(DEFAULT_DIRECTOR_CONFIG));
      newLiveCamId = 'cam-front';
    } else {
      if (payload.roomLayout && typeof payload.roomLayout === 'object') {
        newLayout = { ...newLayout, ...payload.roomLayout };
        // Validate tableShape
        if (!['oval', 'round', 'ushape', 'hollow_square'].includes(newLayout.tableShape)) {
          newLayout.tableShape = 'oval';
        }
        if (typeof newLayout.tableWidthRatio === 'number') {
          newLayout.tableWidthRatio = Math.max(0.2, Math.min(0.9, newLayout.tableWidthRatio));
        }
        if (typeof newLayout.tableHeightRatio === 'number') {
          newLayout.tableHeightRatio = Math.max(0.15, Math.min(0.8, newLayout.tableHeightRatio));
        }
        if (typeof newLayout.seatCount === 'number') {
          newLayout.seatCount = Math.max(2, Math.min(32, Math.round(newLayout.seatCount)));
        }
      }

      if (Array.isArray(payload.cameras)) {
        newCameras = payload.cameras.map((c) => {
          const existing = current.cameras.find((ex) => ex.id === c.id) || {};
          return {
            id: String(c.id || existing.id || 'cam-custom'),
            name: String(c.name || existing.name || 'Camera'),
            role: ['front', 'rear', 'side'].includes(c.role) ? c.role : existing.role || 'side',
            xRatio: Math.max(0.02, Math.min(0.98, Number(c.xRatio ?? existing.xRatio ?? 0.5))),
            yRatio: Math.max(0.02, Math.min(0.98, Number(c.yRatio ?? existing.yRatio ?? 0.5))),
            restingPanDeg: wrapAngle180(Number(c.restingPanDeg ?? existing.restingPanDeg ?? 0)),
            currentPanDeg: wrapAngle180(Number(c.currentPanDeg ?? existing.currentPanDeg ?? c.restingPanDeg ?? 0)),
            targetPanDeg: wrapAngle180(Number(c.targetPanDeg ?? existing.targetPanDeg ?? c.restingPanDeg ?? 0)),
            fovDeg: Math.max(20, Math.min(120, Number(c.fovDeg ?? existing.fovDeg ?? 60))),
            color: String(c.color || existing.color || '#10b981'),
            isLive: c.id === (payload.liveCamId || current.liveCamId),
            assignedTargetSlot: c.assignedTargetSlot !== undefined ? c.assignedTargetSlot : existing.assignedTargetSlot ?? null,
            isLockedOnSubject: Boolean(c.isLockedOnSubject ?? existing.isLockedOnSubject),
            lastTargetPos: c.lastTargetPos ?? existing.lastTargetPos ?? null,
          };
        });
      }

      if (payload.directorConfig && typeof payload.directorConfig === 'object') {
        newDirectorConfig = {
          slewSpeedDegPerSec: Math.max(30, Math.min(360, Number(payload.directorConfig.slewSpeedDegPerSec ?? newDirectorConfig.slewSpeedDegPerSec))),
          instantCut: Boolean(payload.directorConfig.instantCut ?? newDirectorConfig.instantCut),
          holdTimeMs: Math.max(300, Math.min(10000, Number(payload.directorConfig.holdTimeMs ?? newDirectorConfig.holdTimeMs))),
          confirmTimeMs: Math.max(100, Math.min(3000, Number(payload.directorConfig.confirmTimeMs ?? newDirectorConfig.confirmTimeMs))),
          hysteresisMarginPercent: Math.max(0, Math.min(100, Number(payload.directorConfig.hysteresisMarginPercent ?? newDirectorConfig.hysteresisMarginPercent))),
        };
      }

      if (typeof payload.liveCamId === 'string' && payload.liveCamId.trim().length > 0) {
        newLiveCamId = payload.liveCamId.trim();
      }
    }

    const updateStmt = this.db.prepare(`
      INSERT INTO device_studio_config (
        device_id, room_layout_json, cameras_json, director_config_json, live_cam_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        room_layout_json = excluded.room_layout_json,
        cameras_json = excluded.cameras_json,
        director_config_json = excluded.director_config_json,
        live_cam_id = excluded.live_cam_id,
        updated_at = excluded.updated_at
    `);

    updateStmt.run(
      deviceId,
      JSON.stringify(newLayout),
      JSON.stringify(newCameras),
      JSON.stringify(newDirectorConfig),
      newLiveCamId,
      now
    );

    const runtime = this._getOrCreateDeviceRuntimeState(deviceId);
    runtime.liveCamId = newLiveCamId;
    runtime.cameras = newCameras.map((cam) => {
      const existing = runtime.cameras.find((c) => c.id === cam.id);
      return {
        ...cam,
        assignedTargetSlot: existing?.assignedTargetSlot ?? null,
        isLockedOnSubject: existing?.isLockedOnSubject ?? false,
        lastTargetPos: existing?.lastTargetPos ?? null,
        targetPanDeg: existing?.targetPanDeg ?? cam.restingPanDeg,
      };
    });

    return this.getStudioConfig(deviceId);
  }

  /**
   * Evaluates active acoustic tracks and executes the automated camera allocation
   * and Schmitt-trigger switching algorithm.
   *
   * @param {number} deviceId
   * @param {Array<object>} activeTracks
   * @param {Array<object>} records
   * @param {Array<object>} zones
   * @param {number} nowMs
   * @returns {object} Authoritative director telemetry snapshot
   */
  processBatch(deviceId, activeTracks = [], records = [], zones = [], nowMs = Date.now()) {
    const configData = this.getStudioConfig(deviceId);
    const layout = configData.roomLayout;
    const config = configData.directorConfig;
    const runtime = this._getOrCreateDeviceRuntimeState(deviceId);

    let currentCameras = [...runtime.cameras];
    let currentLiveId = runtime.liveCamId || 'cam-front';

    // 1. Identify active speaker targets
    const speakerTargets = [];
    const activeSlots = activeTracks.filter((t) => t.state === 'ACTIVE' && (t.trackSlot === 0 || t.trackSlot === 1));

    let resolvedZoneName = 'Unassigned';

    for (const track of activeSlots) {
      const pos = calculateTablePerimeterPos(
        BASE_ROOM_CENTER_X,
        BASE_ROOM_CENTER_Y,
        track.angleDeg,
        layout,
        BASE_ROOM_WIDTH,
        BASE_ROOM_HEIGHT
      );
      speakerTargets.push({
        slotId: track.trackSlot,
        pos,
        angleDeg: track.angleDeg,
        isActive: true,
        splDb: track.soundLevelDb,
      });

      const z = resolveSpatialZone(track.angleDeg, zones);
      if (z) resolvedZoneName = z.name;
    }

    // Fallback: If no tracks active, check recent record
    if (speakerTargets.length === 0 && records.length > 0) {
      const latest = records[records.length - 1];
      if (nowMs - latest.timestampMs < 1600 && latest.soundLevelDb >= 50.0) {
        const slot = latest.slotId ?? 0;
        const pos = calculateTablePerimeterPos(
          BASE_ROOM_CENTER_X,
          BASE_ROOM_CENTER_Y,
          latest.angleDeg,
          layout,
          BASE_ROOM_WIDTH,
          BASE_ROOM_HEIGHT
        );
        speakerTargets.push({
          slotId: slot,
          pos,
          angleDeg: latest.angleDeg,
          isActive: true,
          splDb: latest.soundLevelDb,
        });

        const z = resolveSpatialZone(latest.angleDeg, zones);
        if (z) resolvedZoneName = z.name;
      }
    }

    if (speakerTargets.length > 0) {
      runtime.lastRoomAudioTimeMs = nowMs;
    }
    runtime.activeZoneName = resolvedZoneName;

    // 2. Camera-to-Speaker Subject Allocation
    const activeSlotIds = new Set(speakerTargets.map((s) => s.slotId));
    currentCameras = currentCameras.map((c) => {
      if (c.assignedTargetSlot !== null && !activeSlotIds.has(c.assignedTargetSlot)) {
        return { ...c, assignedTargetSlot: null, isLockedOnSubject: false };
      }
      return c;
    });

    if (speakerTargets.length === 1) {
      const spk = speakerTargets[0];
      const scored = currentCameras.map((cam) => ({
        cam,
        score: scoreCameraCandidate(cam, spk.pos, spk.angleDeg, BASE_ROOM_WIDTH, BASE_ROOM_HEIGHT),
      }));
      scored.sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        const bestCam = scored[0].cam;
        currentCameras = currentCameras.map((c) =>
          c.id === bestCam.id
            ? {
                ...c,
                assignedTargetSlot: spk.slotId,
                isLockedOnSubject: true,
                lastTargetPos: spk.pos,
              }
            : c.assignedTargetSlot === spk.slotId
            ? { ...c, assignedTargetSlot: null, isLockedOnSubject: false }
            : c
        );
      }
    } else if (speakerTargets.length > 1) {
      for (const speaker of speakerTargets) {
        let boundCam = currentCameras.find((c) => c.assignedTargetSlot === speaker.slotId);

        if (!boundCam) {
          const availableCams = currentCameras.filter((c) => c.assignedTargetSlot === null);
          const pool = availableCams.length > 0 ? availableCams : currentCameras;

          const scored = pool.map((cam) => ({
            cam,
            score: scoreCameraCandidate(cam, speaker.pos, speaker.angleDeg, BASE_ROOM_WIDTH, BASE_ROOM_HEIGHT),
          }));
          scored.sort((a, b) => b.score - a.score);

          if (scored.length > 0) {
            boundCam = scored[0].cam;
            currentCameras = currentCameras.map((c) =>
              c.id === boundCam.id
                ? {
                    ...c,
                    assignedTargetSlot: speaker.slotId,
                    isLockedOnSubject: true,
                    lastTargetPos: speaker.pos,
                  }
                : c.assignedTargetSlot === speaker.slotId
                ? { ...c, assignedTargetSlot: null, isLockedOnSubject: false }
                : c
            );
          }
        } else {
          currentCameras = currentCameras.map((c) =>
            c.id === boundCam.id ? { ...c, lastTargetPos: speaker.pos } : c
          );
        }
      }
    }

    // 3. Compute target pan bearings for each camera independently
    currentCameras = currentCameras.map((cam) => {
      const camX = cam.xRatio * BASE_ROOM_WIDTH;
      const camY = cam.yRatio * BASE_ROOM_HEIGHT;

      if (cam.assignedTargetSlot !== null) {
        const boundSpeaker = speakerTargets.find((s) => s.slotId === cam.assignedTargetSlot);
        const targetPos = boundSpeaker?.pos || cam.lastTargetPos;

        if (targetPos) {
          const aimAngle = calculateCameraBearing(camX, camY, targetPos.x, targetPos.y);
          return {
            ...cam,
            targetPanDeg: aimAngle,
            isLockedOnSubject: true,
          };
        }
      }

      // Sticky Memory: If it previously had a target and room silence is < 45s, hold position
      const isProlongedSilence = nowMs - runtime.lastRoomAudioTimeMs > 45000;
      if (cam.lastTargetPos && !isProlongedSilence) {
        const holdAngle = calculateCameraBearing(camX, camY, cam.lastTargetPos.x, cam.lastTargetPos.y);
        return {
          ...cam,
          targetPanDeg: holdAngle,
          isLockedOnSubject: true,
        };
      }

      // Otherwise, hold resting pan angle
      return {
        ...cam,
        targetPanDeg: cam.restingPanDeg,
        isLockedOnSubject: false,
      };
    });

    // 4. Schmitt-Trigger Live Switcher ("ON AIR" Selection)
    let newLiveId = currentLiveId;
    let hasSwitched = false;

    const dominantSpeaker = speakerTargets.slice().sort((a, b) => b.splDb - a.splDb)[0];

    if (dominantSpeaker) {
      const targetCam = currentCameras.find((c) => c.assignedTargetSlot === dominantSpeaker.slotId);

      if (targetCam && targetCam.id !== currentLiveId) {
        const currentLiveCam = currentCameras.find((c) => c.id === currentLiveId);
        const isCurrentLiveTrackingActiveSpeaker =
          currentLiveCam &&
          currentLiveCam.assignedTargetSlot !== null &&
          speakerTargets.some((s) => s.slotId === currentLiveCam.assignedTargetSlot);

        const timeSinceLastSwitch = nowMs - runtime.lastSwitchTimeMs;

        // Immediate cut when currently live camera is NOT tracking any active speaker
        if (!isCurrentLiveTrackingActiveSpeaker) {
          if (runtime.candidateCamId !== targetCam.id) {
            runtime.candidateCamId = targetCam.id;
            runtime.candidateStartTimeMs = nowMs;
          } else if (nowMs - runtime.candidateStartTimeMs >= Math.min(config.confirmTimeMs, 150)) {
            newLiveId = targetCam.id;
            hasSwitched = true;
            runtime.lastSwitchTimeMs = nowMs;
            runtime.candidateCamId = null;
            runtime.liveCamId = newLiveId;
          }
        } else {
          // Both cameras framing active speakers -> Apply Schmitt-trigger hysteresis
          const liveScore = scoreCameraCandidate(
            currentLiveCam,
            dominantSpeaker.pos,
            dominantSpeaker.angleDeg,
            BASE_ROOM_WIDTH,
            BASE_ROOM_HEIGHT
          );
          const targetScore = scoreCameraCandidate(
            targetCam,
            dominantSpeaker.pos,
            dominantSpeaker.angleDeg,
            BASE_ROOM_WIDTH,
            BASE_ROOM_HEIGHT
          );
          const threshold = liveScore * (1.0 + config.hysteresisMarginPercent / 100.0);

          if (timeSinceLastSwitch >= config.holdTimeMs && targetScore >= threshold) {
            if (runtime.candidateCamId !== targetCam.id) {
              runtime.candidateCamId = targetCam.id;
              runtime.candidateStartTimeMs = nowMs;
            } else if (nowMs - runtime.candidateStartTimeMs >= config.confirmTimeMs) {
              newLiveId = targetCam.id;
              hasSwitched = true;
              runtime.lastSwitchTimeMs = nowMs;
              runtime.candidateCamId = null;
              runtime.liveCamId = newLiveId;
            }
          } else {
            runtime.candidateCamId = null;
          }
        }
      } else {
        runtime.candidateCamId = null;
      }
    }

    runtime.cameras = currentCameras.map((c) => ({
      ...c,
      isLive: c.id === newLiveId,
    }));

    return {
      liveCamId: newLiveId,
      activeZoneName: runtime.activeZoneName,
      updatedAtMs: nowMs,
      switched: hasSwitched,
      speakers: speakerTargets,
      cameras: runtime.cameras.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        xRatio: c.xRatio,
        yRatio: c.yRatio,
        restingPanDeg: c.restingPanDeg,
        targetPanDeg: Number(c.targetPanDeg.toFixed(1)),
        fovDeg: c.fovDeg,
        color: c.color,
        isLive: c.id === newLiveId,
        assignedTargetSlot: c.assignedTargetSlot,
        isLockedOnSubject: c.isLockedOnSubject,
        lastTargetPos: c.lastTargetPos || null,
      })),
    };
  }
}

export default PTZDirectorService;
