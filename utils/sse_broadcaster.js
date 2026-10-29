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
  }

  removeClient(clientId) {
    if (this.clients.has(clientId)) {
      this.clients.delete(clientId);
      console.log(`[SSE] Client disconnected: ${clientId} (total: ${this.clients.size})`);
    }
  }

  broadcastBatch(deviceId, batch) {
    const payload = JSON.stringify({
      deviceId,
      clockFlags: batch.header.clockFlags,
      clockSource: batch.header.clockSource,
      baseTimestampMs: Number(batch.header.baseTimestampMs),
      crcVerified: Boolean(batch.header.crcVerified),
      records: batch.records,
    });

    const sseMessage = `event: measurement_batch\ndata: ${payload}\n\n`;

    for (const [id, client] of this.clients.entries()) {
      if (client.deviceId === deviceId || client.deviceId === 0) {
        try {
          client.res.write(sseMessage);
        } catch (err) {
          console.error(`[SSE] Write error for client ${id}:`, err);
          this.removeClient(id);
        }
      }
    }
  }

  sendHeartbeat() {
    const heartbeat = `event: heartbeat\ndata: ${JSON.stringify({ server_time_unix_ms: Date.now() })}\n\n`;
    for (const [id, client] of this.clients.entries()) {
      try {
        client.res.write(heartbeat);
      } catch (err) {
        this.removeClient(id);
      }
    }
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
