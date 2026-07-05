import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt, { Algorithm, GetPublicKeyOrSecret, JwtPayload } from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';
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

interface SupabaseJwtPayload extends JwtPayload {
  email?: string;
  user_metadata?: { full_name?: string; name?: string; user_name?: string };
}

// Supabase user access tokens carry aud="authenticated". Pin it so a token minted
// for a different audience but by the same project isn't accepted here.
const AUDIENCE = 'authenticated';
// Asymmetric algorithms only — the project signs with its JWKS keys (ES256 by
// default). Pinning to asymmetric algs prevents alg=none and HS/RS confusion.
const ALGORITHMS: Algorithm[] = ['ES256', 'RS256'];

/**
 * Builds the project's JWKS discovery URL from SUPABASE_URL, e.g.
 * https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
 */
function jwksUri(): string {
  const base = process.env.SUPABASE_URL;
  if (!base) {
    throw new Error('SUPABASE_URL is not set — cannot verify auth tokens.');
  }
  return `${base.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
}

let cachedGetKey: GetPublicKeyOrSecret | undefined;

/** Resolves the signing key for a token by its `kid`, from the remote JWKS (cached). */
function remoteGetKey(): GetPublicKeyOrSecret {
  if (cachedGetKey) return cachedGetKey;
  const client = new JwksClient({ jwksUri: jwksUri(), cache: true, rateLimit: true });
  cachedGetKey = (header, callback) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err || !key) {
        callback(err || new Error('Signing key not found for kid.'));
        return;
      }
      callback(null, key.getPublicKey());
    });
  };
  return cachedGetKey;
}

function verifyToken(token: string, getKey: GetPublicKeyOrSecret): Promise<SupabaseJwtPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, { algorithms: ALGORITHMS, audience: AUDIENCE }, (err, decoded) => {
      if (err) reject(err);
      else resolve(decoded as SupabaseJwtPayload);
    });
  });
}

/**
 * Middleware factory. Verifies the Supabase JWT with the given key resolver, then
 * upserts the Supabase identity into our User table and attaches req.userId. The
 * key resolver is injectable so tests can verify against a local key pair without
 * hitting the network. On any verification failure the request is rejected 401.
 */
export function createRequireAuth(getKey: GetPublicKeyOrSecret): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401).json({ error: 'Missing or malformed Authorization header.' });
      return;
    }

    let payload: SupabaseJwtPayload;
    try {
      payload = await verifyToken(match[1], getKey);
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
  };
}

/**
 * Production middleware: verifies against the project's remote JWKS. A missing
 * SUPABASE_URL is a server misconfiguration (500), not the caller's fault (401).
 */
export const requireAuth: RequestHandler = (req, res, next) => {
  let getKey: GetPublicKeyOrSecret;
  try {
    getKey = remoteGetKey();
  } catch {
    console.error('[auth] SUPABASE_URL is not set — cannot verify tokens.');
    res.status(500).json({ error: 'Authentication is not configured on the server.' });
    return;
  }
  void createRequireAuth(getKey)(req, res, next);
};
