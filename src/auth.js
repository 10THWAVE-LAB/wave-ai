// WAVE AI — auth helpers for Cloudflare Workers.
// Passwords: PBKDF2 via WebCrypto (crypto.subtle). bcrypt is NOT used:
// Workers have a small CPU budget per request and bcrypt would blow it,
// while PBKDF2 runs natively in the runtime.
// Sessions: HS256 JWTs (hono/jwt, also WebCrypto-based) in an httpOnly cookie.
// No Node-only APIs anywhere in this file.

import { sign, verify } from 'hono/jwt';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 days

function b64encode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(str) {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function deriveKey(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial,
      KEY_BYTES * 8
    )
  );
}

// Stored format: pbkdf2$<iterations>$<base64 salt>$<base64 key>
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(key)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 1) return false;
    const salt = b64decode(parts[2]);
    const expected = b64decode(parts[3]);
    const actual = await deriveKey(password, salt, iterations);
    // Constant-time comparison.
    let diff = expected.length ^ actual.length;
    const len = Math.min(expected.length, actual.length);
    for (let i = 0; i < len; i++) diff |= expected[i] ^ actual[i];
    return diff === 0;
  } catch {
    return false;
  }
}

export async function issueToken(secret, user) {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { id: user.id, email: user.email, iat: now, exp: now + SESSION_TTL_SECONDS },
    secret
  );
}

// Returns the payload ({id, email, ...}) or null when invalid/expired.
// NOTE: hono/jwt requires the algorithm to be passed explicitly.
export async function verifyToken(secret, token) {
  try {
    return await verify(token, secret, 'HS256');
  } catch {
    return null;
  }
}

export { SESSION_TTL_SECONDS };
