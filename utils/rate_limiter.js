/**
 * In-memory sliding-window rate limiter middleware (zero external dependencies).
 */

export function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 15,
  code = 'TOO_MANY_REQUESTS',
  message = 'Too many attempts. Please wait and try again later.',
} = {}) {
  const buckets = new Map();

  // Periodically prune expired IP entries so memory stays bounded
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of buckets.entries()) {
      const fresh = timestamps.filter((ts) => now - ts < windowMs);
      if (fresh.length === 0) {
        buckets.delete(key);
      } else {
        buckets.set(key, fresh);
      }
    }
  }, Math.min(windowMs, 60 * 1000));

  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  return function rateLimitMiddleware(req, res, next) {
    if (max <= 0) {
      return next();
    }

    const now = Date.now();
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const existing = buckets.get(clientIp) || [];
    const active = existing.filter((ts) => now - ts < windowMs);

    if (active.length >= max) {
      const oldestMs = active[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldestMs + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: {
          code,
          message,
          status: 429,
        },
      });
    }

    active.push(now);
    buckets.set(clientIp, active);
    return next();
  };
}

export default createRateLimiter;
