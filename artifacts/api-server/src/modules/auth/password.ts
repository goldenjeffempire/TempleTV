import bcrypt from "bcryptjs";
import { env } from "../../config/env.js";

// F35: work factor is configurable via BCRYPT_ROUNDS env var (default 12).
// Raise to 13-14 on dedicated hardware; lower to 10 in test environments
// where hashing speed matters more than security (BCRYPT_ROUNDS=10).
const ROUNDS = env.BCRYPT_ROUNDS;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plain, hashed);
}
