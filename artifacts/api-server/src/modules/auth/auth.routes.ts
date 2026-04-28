import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AuthTokensSchema,
  LoginBodySchema,
  MeResponseSchema,
  RefreshBodySchema,
  RegisterBodySchema,
} from "./auth.schemas.js";
import { authService } from "./auth.service.js";
import { requireAuth } from "../../middleware/auth.js";

export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/register",
    {
      schema: {
        tags: ["auth"],
        summary: "Register a new viewer account",
        body: RegisterBodySchema,
        response: { 201: AuthTokensSchema },
      },
    },
    async (req, reply) => {
      const tokens = await authService.register(req.body);
      reply.code(201);
      return tokens;
    },
  );

  r.post(
    "/login",
    {
      schema: {
        tags: ["auth"],
        summary: "Exchange credentials for a JWT pair",
        body: LoginBodySchema,
        response: { 200: AuthTokensSchema },
      },
    },
    async (req) => authService.login(req.body),
  );

  r.post(
    "/refresh",
    {
      schema: {
        tags: ["auth"],
        summary: "Rotate refresh token + issue new access token",
        body: RefreshBodySchema,
        response: { 200: AuthTokensSchema },
      },
    },
    async (req) => authService.refresh(req.body.refreshToken),
  );

  r.post(
    "/logout",
    {
      schema: {
        tags: ["auth"],
        summary: "Revoke a refresh token",
        body: RefreshBodySchema,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await authService.logout(req.body.refreshToken);
      reply.code(204);
      return null;
    },
  );

  r.get(
    "/me",
    {
      preHandler: requireAuth(),
      schema: {
        tags: ["auth"],
        summary: "Current authenticated principal",
        security: [{ bearerAuth: [] }],
        response: { 200: MeResponseSchema },
      },
    },
    async (req) => authService.getProfile(req.principal!.id),
  );
}
