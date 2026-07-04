import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Authenticated symmetric encryption for secrets at rest (currently per-user GitHub
 * OAuth tokens). AES-256-GCM: confidentiality + integrity, so a tampered ciphertext
 * fails to decrypt rather than yielding garbage.
 *
 * The key comes from TOKEN_ENCRYPTION_KEY — 32 bytes, provided as 64 hex chars or
 * base64. Generate one with `openssl rand -hex 32`. Resolved lazily so importing this
 * module (e.g. in tests that don't encrypt) doesn't require the env var to be set.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

function loadKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('TOKEN_ENCRYPTION_KEY is not set — cannot encrypt/decrypt secrets.');
  }
  // Accept hex (64 chars) or base64.
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        'Use `openssl rand -hex 32`.'
    );
  }
  return key;
}

/** Encrypts a UTF-8 string. Returns `iv:authTag:ciphertext`, each part base64. */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypts a value produced by encryptSecret. Throws if the format is wrong or the
 * ciphertext/tag has been tampered with (GCM auth failure).
 */
export function decryptSecret(encoded: string): string {
  const key = loadKey();
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret — expected iv:authTag:ciphertext.');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
