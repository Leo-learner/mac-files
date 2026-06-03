// Simple in-memory rate limiter with automatic cleanup
const { clampNumber } = require('./math');

function createRateLimiter({ name, windowMs, max }) {
  const disabled = process.env.RATE_LIMIT_DISABLED === 'true';
  const hits = new Map();
  const safeWindowMs = clampNumber(windowMs, 60000, 1000, 60 * 60 * 1000);
  const safeMax = clampNumber(max, 60, 1, 10000);

  // Periodic cleanup: evict expired entries so the Map doesn't grow unboundedly
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) hits.delete(key);
    }
  }, Math.min(safeWindowMs, 60000)).unref();

  return (req, res, next) => {
    if (disabled) return next();
    const now = Date.now();
    const identity = req.user?.id || req.ip || 'anonymous';
    const key = `${name}:${identity}`;
    const current = hits.get(key);
    if (!current || now > current.resetAt) {
      hits.set(key, { count: 1, resetAt: now + safeWindowMs });
      return next();
    }
    current.count += 1;
    if (current.count > safeMax) {
      res.setHeader('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    return next();
  };
}

module.exports = { createRateLimiter };
