/** Generate a new 160-bit TOTP secret (base32-encoded, uppercase). */
export declare function generateTotpSecret(): string;
/** Generate the current TOTP code for a secret (useful for testing). */
export declare function generateTotpCode(secret: string): string;
/**
 * Verify a 6-digit TOTP code.
 * Accepts ±WINDOW time steps to tolerate clock drift.
 */
export declare function verifyTotpCode(code: string, secret: string): boolean;
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
export declare function verifyTotpCodeWithCounter(code: string, secret: string, lastCounter: bigint | null | undefined): {
    valid: true;
    matchedCounter: bigint;
} | {
    valid: false;
    matchedCounter: null;
};
/**
 * Build the `otpauth://` URI recognised by Google Authenticator, Authy, etc.
 * The URI encodes the issuer, account email, secret, algorithm, digits, and period
 * so scanning the resulting QR code fully configures the authenticator.
 */
export declare function buildOtpauthUri(secret: string, email: string, issuer?: string): string;
/** Generate N one-time backup codes (hex, formatted as XXXX-XXXX). */
export declare function generateBackupCodes(n?: number): string[];
/** SHA-256 hash a backup code for storage. */
export declare function hashBackupCode(code: string): string;
/** Verify and consume a backup code from the hashed list. Returns the updated list. */
export declare function consumeBackupCode(input: string, hashedCodes: string[]): {
    valid: boolean;
    remaining: string[];
};
