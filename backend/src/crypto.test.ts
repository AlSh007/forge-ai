import { encryptSecret, decryptSecret } from './crypto';

describe('crypto (AES-256-GCM secret encryption)', () => {
  const ORIGINAL_KEY = process.env.TOKEN_ENCRYPTION_KEY;

  beforeAll(() => {
    // 64 hex chars = 32 bytes = AES-256 key.
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  });

  afterAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  it('round-trips a value', () => {
    const secret = 'gho_exampleGitHubToken_1234567890';
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same-value');
    expect(decryptSecret(b)).toBe('same-value');
  });

  it('throws on a tampered ciphertext (GCM auth failure)', () => {
    const encrypted = encryptSecret('tamper-me');
    const [iv, tag, data] = encrypted.split(':');
    // Flip a byte in the ciphertext.
    const bad = Buffer.from(data, 'base64');
    bad[0] = bad[0] ^ 0xff;
    const tampered = [iv, tag, bad.toString('base64')].join(':');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('throws on malformed input', () => {
    expect(() => decryptSecret('not-valid')).toThrow(/Malformed/);
  });

  it('throws when the key is missing', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptSecret('x')).toThrow(/TOKEN_ENCRYPTION_KEY/);
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  });

  it('rejects a key of the wrong length', () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'abcd';
    expect(() => encryptSecret('x')).toThrow(/32 bytes/);
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  });
});
