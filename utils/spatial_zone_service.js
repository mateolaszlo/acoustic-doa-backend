/**
 * Spatial Zone Service
 * Manages spatial zones / geofenced angular sectors for room diorama & diarization.
 */

export class SpatialZoneService {
  constructor(db) {
    this.db = db;
  }

  /**
   * Get all spatial zones defined for a device, ordered by min_angle_deg ascending.
   * @param {number} deviceId
   * @returns {Array<object>}
   */
  getZones(deviceId) {
    const stmt = this.db.prepare(`
      SELECT id, device_id, name, min_angle_deg, max_angle_deg, color, alert_threshold_db, created_at
      FROM spatial_zones
      WHERE device_id = ?
      ORDER BY min_angle_deg ASC
    `);
    const rows = stmt.all(deviceId);
    return rows.map((r) => ({
      id: r.id,
      device_id: r.device_id,
      name: r.name,
      min_angle_deg: Number(r.min_angle_deg),
      max_angle_deg: Number(r.max_angle_deg),
      color: r.color || '#10b981',
      alert_threshold_db: r.alert_threshold_db !== null ? Number(r.alert_threshold_db) : 75.0,
      created_at: r.created_at,
    }));
  }

  /**
   * Replace all spatial zones for a device with a new configuration.
   * @param {number} deviceId
   * @param {Array<object>} zones
   * @returns {{ success: boolean, error?: string, zones?: Array<object> }}
   */
  updateZones(deviceId, zones) {
    if (!Array.isArray(zones)) {
      return { success: false, error: 'Zones payload must be an array' };
    }

    if (zones.length > 32) {
      return { success: false, error: 'A maximum of 32 spatial zones is supported' };
    }

    // Validate each zone
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      if (!z || typeof z !== 'object') {
        return { success: false, error: `Zone at index ${i} is invalid` };
      }

      if (typeof z.name !== 'string' || z.name.trim().length === 0 || z.name.trim().length > 64) {
        return { success: false, error: `Zone at index ${i} must have a name between 1 and 64 characters` };
      }

      const minDeg = Number(z.min_angle_deg);
      const maxDeg = Number(z.max_angle_deg);

      if (isNaN(minDeg) || minDeg < -180 || minDeg > 180) {
        return { success: false, error: `Zone '${z.name}' min_angle_deg must be between -180 and +180` };
      }

      if (isNaN(maxDeg) || maxDeg < -180 || maxDeg > 180) {
        return { success: false, error: `Zone '${z.name}' max_angle_deg must be between -180 and +180` };
      }

      if (minDeg === maxDeg) {
        return { success: false, error: `Zone '${z.name}' min_angle_deg (${minDeg}) cannot equal max_angle_deg (${maxDeg})` };
      }

      if (minDeg > maxDeg && !(minDeg > 0 && maxDeg < 0)) {
        return {
          success: false,
          error: `Zone '${z.name}' min_angle_deg (${minDeg}) cannot exceed max_angle_deg (${maxDeg}) unless wrapping across South (min > 0, max < 0)`,
        };
      }

      if (z.alert_threshold_db !== undefined && z.alert_threshold_db !== null) {
        const threshold = Number(z.alert_threshold_db);
        if (isNaN(threshold) || threshold < 30 || threshold > 130) {
          return { success: false, error: `Zone '${z.name}' alert_threshold_db must be between 30 and 130 dB` };
        }
      }
    }

    // Atomically replace zones for this device
    const deleteStmt = this.db.prepare('DELETE FROM spatial_zones WHERE device_id = ?');
    const insertStmt = this.db.prepare(`
      INSERT INTO spatial_zones (device_id, name, min_angle_deg, max_angle_deg, color, alert_threshold_db, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();

    const hexColorRegex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

    this.db.transaction(() => {
      deleteStmt.run(deviceId);
      for (const z of zones) {
        const color = typeof z.color === 'string' && hexColorRegex.test(z.color.trim())
          ? z.color.trim()
          : '#10b981';
        const threshold = z.alert_threshold_db !== undefined && z.alert_threshold_db !== null
          ? Number(z.alert_threshold_db)
          : 75.0;

        insertStmt.run(
          deviceId,
          z.name.trim(),
          Number(z.min_angle_deg),
          Number(z.max_angle_deg),
          color,
          threshold,
          now
        );
      }
    })();

    return {
      success: true,
      zones: this.getZones(deviceId),
    };
  }
}

export default SpatialZoneService;
