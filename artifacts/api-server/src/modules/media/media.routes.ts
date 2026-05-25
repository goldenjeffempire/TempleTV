import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateMediaBodySchema,
  ListMediaQuerySchema,
  ListMediaResponseSchema,
  MediaItemSchema,
  SignedUploadBodySchema,
  SignedUploadResponseSchema,
  UpdateMediaBodySchema,
} from "./media.schemas.js";
import { mediaService } from "./media.service.js";
import { requireAuth } from "../../middleware/auth.js";

export async function mediaRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/",
    {
      schema: {
        tags: ["media"],
        summary: "List media items (catalog)",
        querystring: ListMediaQuerySchema,
        response: { 200: ListMediaResponseSchema },
      },
    },
    async (req) => mediaService.list(req.query),
  );

  r.get(
    "/:id",
    {
      schema: {
        tags: ["media"],
        summary: "Single media item by id",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: { 200: MediaItemSchema },
      },
    },
    async (req) => mediaService.getById(req.params.id),
  );

  r.post(
    "/:id/views",
    {
      // Anonymous analytics ping. 60/min per IP prevents counter inflation
      // from bots or runaway clients while allowing fast-switching viewers.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["media"],
        summary: "Increment view counter (analytics ping)",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await mediaService.incrementViewCount(req.params.id);
      reply.code(204);
      return null;
    },
  );

  r.post(
    "/",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["media"],
        summary: "Admin: create a new media item",
        body: CreateMediaBodySchema,
        response: { 201: MediaItemSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await mediaService.create(req.body);
      reply.code(201);
      return created;
    },
  );

  r.patch(
    "/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["media"],
        summary: "Admin: update editable fields on a media item",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: UpdateMediaBodySchema,
        response: { 200: MediaItemSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => mediaService.update(req.params.id, req.body),
  );

  r.delete(
    "/:id",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["media"],
        summary: "Admin: hard-delete a media item",
        params: z.object({ id: z.string().min(1).max(128) }),
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => mediaService.delete(req.params.id),
  );

  r.post(
    "/uploads/signed-url",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["media"],
        summary: "Admin: get a presigned PUT URL for direct-to-S3 upload",
        body: SignedUploadBodySchema,
        response: { 200: SignedUploadResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => mediaService.createSignedUpload(req.body),
  );
}
