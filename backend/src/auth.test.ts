import { generateKeyPairSync } from 'crypto';
import jwt, { GetPublicKeyOrSecret } from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { createRequireAuth, requireAuth } from './auth';

// A project signing key pair (ES256 / P-256), and a second, unrelated pair used to
// simulate a token signed by the wrong key.
function ecKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

const project = ecKeyPair();
const attacker = ecKeyPair();

// Key resolver that always returns the project's public key (stands in for the
// remote JWKS lookup by kid).
const getKey: GetPublicKeyOrSecret = (_header, cb) => cb(null, project.publicPem);
const requireAuthTest = createRequireAuth(getKey);

function sign(payload: object, privatePem: string = project.privatePem, opts: jwt.SignOptions = {}) {
  return jwt.sign(payload, privatePem, {
    algorithm: 'ES256',
    expiresIn: '1h',
    audience: 'authenticated',
    ...opts,
  });
}

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = ((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as Response['status'];
  res.json = ((payload: unknown) => {
    res.body = payload;
    return res as Response;
  }) as Response['json'];
  return res as Response & { statusCode?: number; body?: unknown };
}

function mockReq(authHeader?: string): Request {
  return { headers: authHeader ? { authorization: authHeader } : {} } as Request;
}

describe('requireAuth middleware (JWKS / ES256)', () => {
  it('accepts a valid token and sets req.userId', async () => {
    const req = mockReq(`Bearer ${sign({ sub: 'sb-user-1', email: 'a@example.com' })}`);
    let called = false;
    await requireAuthTest(req, mockRes(), (() => {
      called = true;
    }) as NextFunction);
    expect(called).toBe(true);
    expect(typeof req.userId).toBe('string');
    expect(req.userId!.length).toBeGreaterThan(0);
  });

  it('maps the same Supabase id to a stable userId', async () => {
    const token = `Bearer ${sign({ sub: 'stable-sub', email: 'stable@example.com' })}`;
    const r1 = mockReq(token);
    const r2 = mockReq(token);
    const noop: NextFunction = () => undefined;
    await requireAuthTest(r1, mockRes(), noop);
    await requireAuthTest(r2, mockRes(), noop);
    expect(r1.userId).toBe(r2.userId);
  });

  it('rejects a missing Authorization header with 401', async () => {
    const res = mockRes();
    await requireAuthTest(mockReq(), res, (() => undefined) as NextFunction);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed by the wrong key with 401', async () => {
    const res = mockRes();
    const bad = `Bearer ${sign({ sub: 'x', email: 'x@example.com' }, attacker.privatePem)}`;
    let called = false;
    await requireAuthTest(mockReq(bad), res, (() => {
      called = true;
    }) as NextFunction);
    expect(res.statusCode).toBe(401);
    expect(called).toBe(false);
  });

  it('rejects an expired token with 401', async () => {
    const res = mockRes();
    const expired = sign({ sub: 'x', email: 'x@example.com' }, project.privatePem, { expiresIn: -10 });
    await requireAuthTest(mockReq(`Bearer ${expired}`), res, (() => undefined) as NextFunction);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token with the wrong audience with 401', async () => {
    const res = mockRes();
    const wrongAud = sign({ sub: 'x', email: 'x@example.com' }, project.privatePem, {
      audience: 'some-other-service',
    });
    await requireAuthTest(mockReq(`Bearer ${wrongAud}`), res, (() => undefined) as NextFunction);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token missing required claims with 401', async () => {
    const res = mockRes();
    await requireAuthTest(
      mockReq(`Bearer ${sign({ sub: 'no-email' })}`),
      res,
      (() => undefined) as NextFunction
    );
    expect(res.statusCode).toBe(401);
  });

  it('returns 500 when SUPABASE_URL is not configured (production middleware)', async () => {
    const original = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    const res = mockRes();
    requireAuth(mockReq('Bearer whatever'), res, (() => undefined) as NextFunction);
    // requireAuth is synchronous up to the config check.
    expect(res.statusCode).toBe(500);
    process.env.SUPABASE_URL = original;
  });
});
