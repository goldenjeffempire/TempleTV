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
        email: string;
        role: "system" | "admin" | "editor" | "user";
        id: string;
        displayName: string;
    }, {
        email: string;
        role: "system" | "admin" | "editor" | "user";
        id: string;
        displayName: string;
    }>;
}, "strip", z.ZodTypeAny, {
    user: {
        email: string;
        role: "system" | "admin" | "editor" | "user";
        id: string;
        displayName: string;
    };
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresIn: number;
    refreshTokenExpiresIn: number;
}, {
    user: {
        email: string;
        role: "system" | "admin" | "editor" | "user";
        id: string;
        displayName: string;
    };
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresIn: number;
    refreshTokenExpiresIn: number;
}>;
export type AuthTokens = z.infer<typeof AuthTokensSchema>;
export declare const MeResponseSchema: z.ZodObject<{
    id: z.ZodString;
    email: z.ZodString;
    role: z.ZodEnum<["admin", "editor", "user", "system"]>;
    displayName: z.ZodString;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    email: string;
    role: "system" | "admin" | "editor" | "user";
    id: string;
    displayName: string;
    createdAt: string;
}, {
    email: string;
    role: "system" | "admin" | "editor" | "user";
    id: string;
    displayName: string;
    createdAt: string;
}>;
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
