/**
 * Server-Sent Events (SSE) Broadcaster
 * Manages active web client subscriptions, sends heartbeats, and broadcasts live measurement batches
 */

class SSEBroadcaster {
  constructor() {
    this.clients = new Map();
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 15000);
  }

  addClient(clientId, deviceId, res) {
    try {
      // Set mandatory SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering on NGINX
      res.flushHeaders?.();

      const client = { id: clientId, deviceId, res };
      this.clients.set(clientId, client);

      // Initial connection event
      res.write(`event: connected\ndata: ${JSON.stringify({ deviceId, connectedAt: new Date().toISOString() })}\n\n`);

      res.on('close', () => {
        this.removeClient(clientId);
      });

      console.log(`[SSE] Client connected: ${clientId} for device ${deviceId} (total: ${this.clients.size})`);
    } catch (err) {
      console.error(`[SSE] Failed to initialize client ${clientId}:`, err);
      this.removeClient(clientId);
      throw err;
    }
  }

  removeClient(clientId) {
    if (this.clients.has(clientId)) {
      this.clients.delete(clientId);
      console.log(`[SSE] Client disconnected: ${clientId} (total: ${this.clients.size})`);
    }
  }

  _broadcastEvent(eventName, payload, deviceId = null) {
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch (err) {
      console.error(`[SSE] Failed to serialize '${eventName}' event:`, err);
      return false;
    }

    const sseMessage = `event: ${eventName}\ndata: ${serialized}\n\n`;

    for (const [id, client] of this.clients.entries()) {
      if (deviceId === null || client.deviceId === deviceId || client.deviceId === 0) {
        try {
          client.res.write(sseMessage);
        } catch (err) {
          console.error(`[SSE] Write error for client ${id}:`, err);
          this.removeClient(id);
        }
      }
    }
    return true;
  }

  broadcastBatch(deviceId, batch) {
    const payload = {
      deviceId,
      clockFlags: batch?.header?.clockFlags,
      clockSource: batch?.header?.clockSource,
      baseTimestampMs: batch?.header?.baseTimestampMs !== undefined ? Number(batch.header.baseTimestampMs) : Date.now(),
      crcVerified: Boolean(batch?.header?.crcVerified),
      records: batch?.records || [],
      activeTracks: batch?.activeTracks || [],
      director: batch?.director || null,
    };

    return this._broadcastEvent('measurement_batch', payload, deviceId);
  }

  broadcastStudioConfig(deviceId, studioSnapshot) {
    return this._broadcastEvent('studio_config', studioSnapshot, deviceId);
  }

  sendHeartbeat() {
    this._broadcastEvent('heartbeat', { server_time_unix_ms: Date.now() }, null);
  }

  getClientCount() {
    return this.clients.size;
  }

  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const client of this.clients.values()) {
      try {
        client.res.end();
      } catch {}
    }
    this.clients.clear();
  }
}

export const sseBroadcaster = new SSEBroadcaster();
export default sseBroadcaster;
