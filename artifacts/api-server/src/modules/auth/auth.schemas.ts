import { z } from "zod";

export const RoleSchema = z.enum(["admin", "editor", "user", "system"]);

export const RegisterBodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(80).optional(),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const LoginBodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

export const RefreshBodySchema = z.object({
  refreshToken: z.string().min(10),
});

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresIn: z.number().int().positive(),
  refreshTokenExpiresIn: z.number().int().positive(),
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    role: RoleSchema,
    displayName: z.string(),
  }),
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

/**
 * Returned by POST /auth/login when the account has TOTP MFA enabled.
 * The client must POST the 6-digit code + this token to POST /auth/mfa/verify
 * within 5 minutes to receive the real access/refresh token pair.
 */
export const MfaChallengeSchema = z.object({
  mfaRequired: z.literal(true),
  mfaToken: z.string(),
});
export type MfaChallenge = z.infer<typeof MfaChallengeSchema>;

/** Discriminated union: either full auth tokens or an MFA challenge. */
export const LoginResponseSchema = z.union([AuthTokensSchema, MfaChallengeSchema]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ── MFA setup / management ────────────────────────────────────────────────────

export const MfaSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
  backupCodes: z.array(z.string()),
});

export const MfaEnableBodySchema = z.object({
  code: z.string().length(6).regex(/^\d{6}$/),
});

export const MfaDisableBodySchema = z.object({
  code: z.string().length(6).regex(/^\d{6}$/).optional(),
  backupCode: z.string().optional(),
  password: z.string().min(1).max(128),
});

export const MfaVerifyBodySchema = z.object({
  mfaToken: z.string().min(10),
  code: z.string().length(6).regex(/^\d{6}$/).optional(),
  backupCode: z.string().optional(),
});

export const MfaStatusSchema = z.object({
  enabled: z.boolean(),
  configuredAt: z.string().nullable(),
  backupCodesRemaining: z.number().int(),
});

export const MeResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: RoleSchema,
  displayName: z.string(),
  createdAt: z.string(),
  mfaEnabled: z.boolean(),
});

// ── Token extend (non-rotating keep-alive) ────────────────────────────────────

/**
 * POST /auth/extend — issues a new access token without revoking the
 * refresh token. Used by the client keep-alive so normal session maintenance
 * never triggers a rotation race between concurrent admin tabs.
 * Only rotates when the refresh token has < 7 days remaining.
 */
export const ExtendBodySchema = z.object({
  refreshToken: z.string().min(10),
});

export const ExtendResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresIn: z.number().int().positive(),
  /** Present only when the refresh token was near-expiry and was rotated. */
  refreshToken: z.string().optional(),
  refreshTokenExpiresIn: z.number().int().positive().optional(),
});
export type ExtendResponse = z.infer<typeof ExtendResponseSchema>;

export const ForgotPasswordBodySchema = z.object({
  email: z.string().email().max(254),
});
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBodySchema>;

export const ResetPasswordBodySchema = z.object({
  token: z.string().min(16).max(512),
  password: z.string().min(8).max(128),
});
export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>;
