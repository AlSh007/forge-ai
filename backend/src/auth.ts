import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { storage } from './storage';

// Make the authenticated local user id available on the request.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

interface SupabaseJwtPayload {
  sub?: string;
  email?: string;
  user_metadata?: { full_name?: string; name?: string; user_name?: string };
}

/**
 * Verifies the Supabase Auth JWT on the request and resolves it to a local user.
 *
 * Supabase signs access tokens with HS256 using the project JWT secret
 * (SUPABASE_JWT_SECRET). We verify locally (no network call), then upsert the
 * Supabase identity into our User table and attach `req.userId`. On any failure the
 * request is rejected with 401 — except a missing server secret, which is a 500
 * (misconfiguration, not the caller's fault).
 *
 * Note: if the Supabase project has migrated to asymmetric signing keys, this must
 * switch to JWKS-based verification. HS256 + shared secret is the default.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.error('[auth] SUPABASE_JWT_SECRET is not set — cannot verify tokens.');
    res.status(500).json({ error: 'Authentication is not configured on the server.' });
    return;
  }

  const header = req.headers.authorization ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    return;
  }

  let payload: SupabaseJwtPayload;
  try {
    // Pin the algorithm (no alg=none / RS256→HS256 confusion) and the audience
    // (Supabase user access tokens carry aud="authenticated"), so a token signed
    // with the same secret for a different audience isn't accepted here.
    payload = jwt.verify(match[1], secret, {
      algorithms: ['HS256'],
      audience: 'authenticated',
    }) as SupabaseJwtPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }

  if (!payload.sub || !payload.email) {
    res.status(401).json({ error: 'Token is missing required claims.' });
    return;
  }

  try {
    const name = payload.user_metadata?.full_name ?? payload.user_metadata?.name ?? null;
    req.userId = await storage.upsertUserBySupabaseId({
      supabaseUserId: payload.sub,
      email: payload.email,
      name,
    });
    next();
  } catch (err) {
    next(err);
  }
}
