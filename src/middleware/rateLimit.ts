/**
 * Rate Limiting Middleware
 * 
 * Simple in-memory rate limiter. For production, use Redis.
 */

import { Context, Next } from 'hono';

interface RateLimitConfig {
  windowMs: number;       // Time window in milliseconds
  maxRequests: number;    // Max requests per window
  keyGenerator?: (c: Context) => string;  // How to identify clients
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}, 60000); // Every minute

export function rateLimit(config: RateLimitConfig) {
  const { 
    windowMs = 60000, 
    maxRequests = 100,
    keyGenerator = (c) => c.req.header('x-forwarded-for') || 'unknown',
  } = config;

  return async (c: Context, next: Next) => {
    const key = keyGenerator(c);
    const now = Date.now();

    let entry = store.get(key);
    
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
      return c.json(
        { 
          error: 'Too many requests',
          retryAfter: Math.ceil((entry.resetAt - now) / 1000),
        },
        429
      );
    }

    await next();
  };
}

// Preset configurations
export const rateLimits = {
  // General API: 100 requests per minute
  general: rateLimit({ windowMs: 60000, maxRequests: 100 }),
  
  // Registration: 10 per minute (prevent spam)
  registration: rateLimit({ windowMs: 60000, maxRequests: 10 }),
  
  // Messaging: 60 per minute
  messaging: rateLimit({ windowMs: 60000, maxRequests: 60 }),
  
  // Search/directory: 30 per minute
  search: rateLimit({ windowMs: 60000, maxRequests: 30 }),
};
