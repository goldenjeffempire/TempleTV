/**
 * TOTP implementation — RFC 6238 / RFC 4226.
 * Zero external dependencies; uses only Node.js built-in `node:crypto`.
 *
 * Algorithm:
 *   TOTP(K, T) = HOTP(K, floor(unix_time / step))
 *   HOTP(K, C) = Truncate( HMAC-SHA1(K, C) )
 */
import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";

// ── Base-32 (RFC 4648) ─────────────────────────────────────────────────────

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]!;
  return out;
}

function base32Decode(str: string): Buffer {
  const s = str.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const char of s) {
    const idx = BASE32.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── HOTP / TOTP core ─────────────────────────────────────────────────────────

function hotp(secret: Buffer, counter: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(counter);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

const STEP_SECS = 30;
const WINDOW = 1; // accept ±1 step for clock skew

// ── Public API ───────────────────────────────────────────────────────────────

/** Generate a new 160-bit TOTP secret (base32-encoded, uppercase). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Generate the current TOTP code for a secret (useful for testing). */
export function generateTotpCode(secret: string): string {
  const t = BigInt(Math.floor(Date.now() / 1000 / STEP_SECS));
  return hotp(base32Decode(secret), t);
}

/**
 * Verify a 6-digit TOTP code.
 * Accepts ±WINDOW time steps to tolerate clock drift.
 */
export function verifyTotpCode(code: string, secret: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const t = BigInt(Math.floor(Date.now() / 1000 / STEP_SECS));
  const secretBuf = base32Decode(secret);
  for (let i = -WINDOW; i <= WINDOW; i++) {
    const expected = hotp(secretBuf, t + BigInt(i));
    const a = Buffer.from(expected.padEnd(6, "0"));
    const b = Buffer.from(code.padEnd(6, "0"));
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * Verify a 6-digit TOTP code with replay protection.
 *
 * Returns the matched time-step counter on success so the caller can
 * atomically persist it and reject any future code at or below that counter,
 * preventing replay attacks within the ±WINDOW clock-skew window.
 *
 * @param code          6-digit string from the authenticator app.
 * @param secret        Base32-encoded TOTP secret from the user record.
 * @param lastCounter   The previously persisted counter (from `last_totp_counter`
 *                      in the DB). Pass null / undefined for the first TOTP use.
 * @returns `{ valid: true, matchedCounter }` on success, `{ valid: false, matchedCounter: null }` on failure.
 */
export function verifyTotpCodeWithCounter(
  code: string,
  secret: string,
  lastCounter: bigint | null | undefined,
): { valid: true; matchedCounter: bigint } | { valid: false; matchedCounter: null } {
  if (!/^\d{6}$/.test(code)) return { valid: false, matchedCounter: null };
  const t = BigInt(Math.floor(Date.now() / 1000 / STEP_SECS));
  const secretBuf = base32Decode(secret);
  for (let i = -WINDOW; i <= WINDOW; i++) {
    const counter = t + BigInt(i);
    // Replay protection: reject codes at or before the last used counter.
    // This prevents an attacker from reusing a captured OTP within the same
    // 30-second window (or adjacent windows due to clock-skew tolerance).
    if (lastCounter !== null && lastCounter !== undefined && counter <= lastCounter) continue;
    const expected = hotp(secretBuf, counter);
    const a = Buffer.from(expected.padEnd(6, "0"));
    const b = Buffer.from(code.padEnd(6, "0"));
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { valid: true, matchedCounter: counter };
    }
  }
  return { valid: false, matchedCounter: null };
}

/**
 * Build the `otpauth://` URI recognised by Google Authenticator, Authy, etc.
 * The URI encodes the issuer, account email, secret, algorithm, digits, and period
 * so scanning the resulting QR code fully configures the authenticator.
 */
export function buildOtpauthUri(secret: string, email: string, issuer = "Temple TV"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  const qs = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(STEP_SECS),
  });
  return `otpauth://totp/${label}?${qs.toString()}`;
}

/** Generate N one-time backup codes (hex, formatted as XXXX-XXXX). */
export function generateBackupCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const raw = randomBytes(4).toString("hex").toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

/** SHA-256 hash a backup code for storage. */
export function hashBackupCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase().replace(/-/g, "")).digest("hex");
}

/** Verify and consume a backup code from the hashed list. Returns the updated list. */
export function consumeBackupCode(
  input: string,
  hashedCodes: string[],
): { valid: boolean; remaining: string[] } {
  const normalized = input.toUpperCase().replace(/-/g, "");
  const hashed = Buffer.from(createHash("sha256").update(normalized).digest("hex"));
  // Use timingSafeEqual for every comparison so the position of a matching
  // code is not leaked via timing side-channel. Array.indexOf uses === which
  // exits on the first match — leaking how many codes were checked before a
  // hit (or miss after all N codes).
  let matchIdx = -1;
  for (let i = 0; i < hashedCodes.length; i++) {
    const stored = Buffer.from(hashedCodes[i]!);
    if (stored.length === hashed.length && timingSafeEqual(stored, hashed)) {
      matchIdx = i;
      // Do NOT break early — always compare all codes to avoid length-based
      // timing leak (short-circuit exits sooner for late-position matches).
    }
  }
  if (matchIdx === -1) return { valid: false, remaining: hashedCodes };
  const remaining = [...hashedCodes];
  remaining.splice(matchIdx, 1);
  return { valid: true, remaining };
}
