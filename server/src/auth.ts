/**
 * Single-user bearer auth.
 *
 * This is a shared secret between one phone and one server. It is adequate
 * for exactly that. If this app is ever given to another person, this must be
 * replaced with real per-user authentication — a shared static token cannot be
 * revoked for one holder without locking out everyone.
 */

import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { config } from './config.js';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const requireAuth: RequestHandler = (req, res, next) => {
  // Node lower-cases incoming header names, so `req.headers.authorization` is
  // the case-insensitive lookup Hono's `c.req.header('authorization')` was.
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token || !safeEqual(token, config.bearerToken)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
};
