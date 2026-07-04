import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth';

const SECRET = 'test-supabase-jwt-secret';

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

function sign(payload: object, secret = SECRET): string {
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn: '1h',
    audience: 'authenticated',
  });
}

describe('requireAuth middleware', () => {
  const ORIGINAL_SECRET = process.env.SUPABASE_JWT_SECRET;

  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.SUPABASE_JWT_SECRET = ORIGINAL_SECRET;
  });

  it('accepts a valid token and sets req.userId', async () => {
    const req = mockReq(`Bearer ${sign({ sub: 'sb-user-1', email: 'a@example.com' })}`);
    const res = mockRes();
    let called = false;
    const next: NextFunction = () => {
      called = true;
    };

    await requireAuth(req, res, next);

    expect(called).toBe(true);
    expect(typeof req.userId).toBe('string');
    expect(req.userId!.length).toBeGreaterThan(0);
  });

  it('maps the same Supabase id to a stable userId', async () => {
    const token = `Bearer ${sign({ sub: 'stable-sub', email: 'stable@example.com' })}`;
    const r1 = mockReq(token);
    const r2 = mockReq(token);
    const noop: NextFunction = () => undefined;
    await requireAuth(r1, mockRes(), noop);
    await requireAuth(r2, mockRes(), noop);
    expect(r1.userId).toBe(r2.userId);
  });

  it('rejects a missing Authorization header with 401', async () => {
    const res = mockRes();
    await requireAuth(mockReq(), res, (() => undefined) as NextFunction);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with the wrong secret with 401', async () => {
    const res = mockRes();
    const bad = `Bearer ${sign({ sub: 'x', email: 'x@example.com' }, 'wrong-secret')}`;
    let called = false;
    await requireAuth(mockReq(bad), res, (() => {
      called = true;
    }) as NextFunction);
    expect(res.statusCode).toBe(401);
    expect(called).toBe(false);
  });

  it('rejects an expired token with 401', async () => {
    const res = mockRes();
    const expired = jwt.sign({ sub: 'x', email: 'x@example.com' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: -10,
      audience: 'authenticated',
    });
    await requireAuth(mockReq(`Bearer ${expired}`), res, (() => undefined) as NextFunction);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token missing required claims with 401', async () => {
    const res = mockRes();
    await requireAuth(
      mockReq(`Bearer ${sign({ sub: 'no-email' })}`),
      res,
      (() => undefined) as NextFunction
    );
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token with the wrong audience with 401', async () => {
    const res = mockRes();
    const wrongAud = jwt.sign({ sub: 'x', email: 'x@example.com' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h',
      audience: 'some-other-service',
    });
    await requireAuth(mockReq(`Bearer ${wrongAud}`), res, (() => undefined) as NextFunction);
    expect(res.statusCode).toBe(401);
  });

  it('returns 500 when the server secret is not configured', async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    const res = mockRes();
    await requireAuth(
      mockReq('Bearer whatever'),
      res,
      (() => undefined) as NextFunction
    );
    expect(res.statusCode).toBe(500);
  });
});
