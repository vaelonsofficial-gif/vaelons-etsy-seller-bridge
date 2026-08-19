import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function keyFromEnv() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (raw.length >= 32) return crypto.createHash('sha256').update(raw).digest();
  throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex chars or at least 32 characters.');
}

export function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function sealJson(value) {
  const key = keyFromEnv();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

export function openJson(blob) {
  const key = keyFromEnv();
  const packed = Buffer.from(blob, 'base64url');
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

export async function saveEncryptedToken(token) {
  const file = process.env.TOKEN_STORE_PATH || './data/etsy-token.enc';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, sealJson(token), { mode: 0o600 });
}

export async function loadEncryptedToken() {
  const file = process.env.TOKEN_STORE_PATH || './data/etsy-token.enc';
  try {
    const blob = await fs.readFile(file, 'utf8');
    return openJson(blob.trim());
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}
