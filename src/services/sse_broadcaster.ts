import { Response } from 'express';
import { DecodedBatch } from '../protocol/binary_types.js';

interface SSEClient {
  id: string;
  deviceId: number;
  res: Response;
}

class SSEBroadcaster {
  private clients: Map<string, SSEClient> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Send heartbeat every 15 seconds to prevent proxy / middlebox idle drops
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 15000);
  }

  public addClient(clientId: string, deviceId: number, res: Response): void {
    // Set mandatory SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering on NGINX
    res.flushHeaders?.();

    const client: SSEClient = { id: clientId, deviceId, res };
    this.clients.set(clientId, client);

    // Initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ deviceId, connectedAt: new Date().toISOString() })}\n\n`);

    res.on('close', () => {
      this.removeClient(clientId);
    });

    console.log(`[SSE] Client connected: ${clientId} for device ${deviceId} (total: ${this.clients.size})`);
  }

  public removeClient(clientId: string): void {
    if (this.clients.has(clientId)) {
      this.clients.delete(clientId);
      console.log(`[SSE] Client disconnected: ${clientId} (total: ${this.clients.size})`);
    }
  }

  public broadcastBatch(deviceId: number, batch: DecodedBatch): void {
    const payload = JSON.stringify({
      deviceId,
      clockFlags: batch.header.clockFlags,
      clockSource: batch.header.clockSource,
      baseTimestampMs: Number(batch.header.baseTimestampMs),
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

  private sendHeartbeat(): void {
    const heartbeat = `event: heartbeat\ndata: ${JSON.stringify({ server_time_unix_ms: Date.now() })}\n\n`;
    for (const [id, client] of this.clients.entries()) {
      try {
        client.res.write(heartbeat);
      } catch (err) {
        this.removeClient(id);
      }
    }
  }

  public close(): void {
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
