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

export const MeResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: RoleSchema,
  displayName: z.string(),
  createdAt: z.string(),
});
