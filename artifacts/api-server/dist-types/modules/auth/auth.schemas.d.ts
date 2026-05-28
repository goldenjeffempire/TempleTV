import { z } from "zod";
export declare const RoleSchema: z.ZodEnum<["admin", "editor", "user", "system"]>;
export declare const RegisterBodySchema: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodString;
    displayName: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    email: string;
    password: string;
    displayName?: string | undefined;
}, {
    email: string;
    password: string;
    displayName?: string | undefined;
}>;
export type RegisterBody = z.infer<typeof RegisterBodySchema>;
export declare const LoginBodySchema: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodString;
}, "strip", z.ZodTypeAny, {
    email: string;
    password: string;
}, {
    email: string;
    password: string;
}>;
export type LoginBody = z.infer<typeof LoginBodySchema>;
export declare const RefreshBodySchema: z.ZodObject<{
    refreshToken: z.ZodString;
}, "strip", z.ZodTypeAny, {
    refreshToken: string;
}, {
    refreshToken: string;
}>;
export declare const AuthTokensSchema: z.ZodObject<{
    accessToken: z.ZodString;
    refreshToken: z.ZodString;
    accessTokenExpiresIn: z.ZodNumber;
    refreshTokenExpiresIn: z.ZodNumber;
    user: z.ZodObject<{
        id: z.ZodString;
        email: z.ZodString;
        role: z.ZodEnum<["admin", "editor", "user", "system"]>;
        displayName: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        email: string;
        displayName: string;
        role: "admin" | "editor" | "user" | "system";
    }, {
        id: string;
        email: string;
        displayName: string;
        role: "admin" | "editor" | "user" | "system";
    }>;
}, "strip", z.ZodTypeAny, {
    user: {
        id: string;
        email: string;
        displayName: string;
        role: "admin" | "editor" | "user" | "system";
    };
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresIn: number;
    refreshTokenExpiresIn: number;
}, {
    user: {
        id: string;
        email: string;
        displayName: string;
        role: "admin" | "editor" | "user" | "system";
    };
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresIn: number;
    refreshTokenExpiresIn: number;
}>;
export type AuthTokens = z.infer<typeof AuthTokensSchema>;
/**
 * Returned by POST /auth/login when the account has TOTP MFA enabled.
 * The client must POST the 6-digit code + this token to POST /auth/mfa/verify
 * within 5 minutes to receive the real access/refresh token pair.
 */
export declare const MfaChallengeSchema: z.ZodObject<{
    mfaRequired: z.ZodLiteral<true>;
    mfaToken: z.ZodString;
}, "strip", z.ZodTypeAny, {
    mfaRequired: true;
    mfaToken: string;
}, {
    mfaRequired: true;
    mfaToken: string;
}>;
export type MfaChallenge = z.infer<typeof MfaChallengeSchema>;
/** Discriminated union: either full auth tokens or an MFA challenge. */
export declare const LoginResponseSchema: z.ZodUnion<[z.ZodObject<{
    accessToken: z.ZodString;
    refreshToken: z.ZodString;
    accessTokenExpiresIn: z.ZodNumber;
    refreshTokenExpiresIn: z.ZodNumber;
    user: z.ZodObject<{
        id: z.ZodString;
        email: z.ZodString;
        role: z.ZodEnum<["admin", "editor", "user", "system"]>;
        displayName: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        email: string;
        displayName: string;
        role: "admin" | "editor" | "user" | "system";
    }, {
        id: string;
        email: string;
        displayName: string;
        role: "admin" | "editor" | "user" | "system";
    }>;
}, "strip", z.ZodTypeAny, {
    user: {
        id: string;
        email: string;
        displayName: string;
        role: "admin" | "editor" | "user" | "system";
    };
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresIn: number;
    refreshTokenExpiresIn: number;
}, {
    user: {
        id: string;
        email: string;
        displayName: string;
        role: "admin" | "editor" | "user" | "system";
    };
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresIn: number;
    refreshTokenExpiresIn: number;
}>, z.ZodObject<{
    mfaRequired: z.ZodLiteral<true>;
    mfaToken: z.ZodString;
}, "strip", z.ZodTypeAny, {
    mfaRequired: true;
    mfaToken: string;
}, {
    mfaRequired: true;
    mfaToken: string;
}>]>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export declare const MfaSetupResponseSchema: z.ZodObject<{
    secret: z.ZodString;
    otpauthUri: z.ZodString;
    backupCodes: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    secret: string;
    otpauthUri: string;
    backupCodes: string[];
}, {
    secret: string;
    otpauthUri: string;
    backupCodes: string[];
}>;
export declare const MfaEnableBodySchema: z.ZodObject<{
    code: z.ZodString;
}, "strip", z.ZodTypeAny, {
    code: string;
}, {
    code: string;
}>;
export declare const MfaDisableBodySchema: z.ZodObject<{
    code: z.ZodOptional<z.ZodString>;
    backupCode: z.ZodOptional<z.ZodString>;
    password: z.ZodString;
}, "strip", z.ZodTypeAny, {
    password: string;
    code?: string | undefined;
    backupCode?: string | undefined;
}, {
    password: string;
    code?: string | undefined;
    backupCode?: string | undefined;
}>;
export declare const MfaVerifyBodySchema: z.ZodObject<{
    mfaToken: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
    backupCode: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    mfaToken: string;
    code?: string | undefined;
    backupCode?: string | undefined;
}, {
    mfaToken: string;
    code?: string | undefined;
    backupCode?: string | undefined;
}>;
export declare const MfaStatusSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    configuredAt: z.ZodNullable<z.ZodString>;
    backupCodesRemaining: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    configuredAt: string | null;
    backupCodesRemaining: number;
}, {
    enabled: boolean;
    configuredAt: string | null;
    backupCodesRemaining: number;
}>;
export declare const MeResponseSchema: z.ZodObject<{
    id: z.ZodString;
    email: z.ZodString;
    role: z.ZodEnum<["admin", "editor", "user", "system"]>;
    displayName: z.ZodString;
    createdAt: z.ZodString;
    mfaEnabled: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: string;
    email: string;
    displayName: string;
    role: "admin" | "editor" | "user" | "system";
    mfaEnabled: boolean;
}, {
    id: string;
    createdAt: string;
    email: string;
    displayName: string;
    role: "admin" | "editor" | "user" | "system";
    mfaEnabled: boolean;
}>;
/**
 * POST /auth/extend — issues a new access token without revoking the
 * refresh token. Used by the client keep-alive so normal session maintenance
 * never triggers a rotation race between concurrent admin tabs.
 * Only rotates when the refresh token has < 7 days remaining.
 */
export declare const ExtendBodySchema: z.ZodObject<{
    refreshToken: z.ZodString;
}, "strip", z.ZodTypeAny, {
    refreshToken: string;
}, {
    refreshToken: string;
}>;
export declare const ExtendResponseSchema: z.ZodObject<{
    accessToken: z.ZodString;
    accessTokenExpiresIn: z.ZodNumber;
    /** Present only when the refresh token was near-expiry and was rotated. */
    refreshToken: z.ZodOptional<z.ZodString>;
    refreshTokenExpiresIn: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    accessToken: string;
    accessTokenExpiresIn: number;
    refreshToken?: string | undefined;
    refreshTokenExpiresIn?: number | undefined;
}, {
    accessToken: string;
    accessTokenExpiresIn: number;
    refreshToken?: string | undefined;
    refreshTokenExpiresIn?: number | undefined;
}>;
export type ExtendResponse = z.infer<typeof ExtendResponseSchema>;
export declare const ForgotPasswordBodySchema: z.ZodObject<{
    email: z.ZodString;
}, "strip", z.ZodTypeAny, {
    email: string;
}, {
    email: string;
}>;
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBodySchema>;
export declare const ResetPasswordBodySchema: z.ZodObject<{
    token: z.ZodString;
    password: z.ZodString;
}, "strip", z.ZodTypeAny, {
    token: string;
    password: string;
}, {
    token: string;
    password: string;
}>;
export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>;
