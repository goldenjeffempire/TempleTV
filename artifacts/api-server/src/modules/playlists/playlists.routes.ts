import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import {
  AddVideoBodySchema,
  CreatePlaylistBodySchema,
  ListPlaylistsResponseSchema,
  PlaylistDetailSchema,
  PlaylistSchema,
  PlaylistVideoSchema,
  ReorderBodySchema,
  UpdatePlaylistBodySchema,
} from "./playlists.schemas.js";
import { playlistsService } from "./playlists.service.js";

const idParam = z.object({ id: z.string().min(1) });
const playlistVideoParams = z.object({
  id: z.string().min(1),
  videoId: z.string().min(1),
});

export async function playlistsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["playlists"],
        summary: "List all playlists with video counts",
        response: { 200: ListPlaylistsResponseSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (_req, reply) => {
      // Playlists are edited infrequently; 30-second public cache cuts DB
      // round-trips on every mobile/TV cold-start and homepage load.
      reply.header("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=60");
      return playlistsService.list();
    },
  );

  r.get(
    "/:id",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["playlists"],
        summary: "Get a single playlist with its ordered video list",
        params: idParam,
        response: { 200: PlaylistDetailSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      // Set Cache-Control AFTER the service call so the header is only sent
      // on 2xx responses. Setting it before would cause CDNs to cache 404s
      // for 60 seconds, blocking retries with valid IDs in the meantime.
      const result = await playlistsService.getById(req.params.id);
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=120");
      return result;
    },
  );

  r.post(
    "/",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["playlists"],
        summary: "Create a new playlist",
        body: CreatePlaylistBodySchema,
        response: { 201: PlaylistSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await playlistsService.create(req.body);
      reply.code(201);
      return created;
    },
  );

  r.patch(
    "/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["playlists"],
        summary: "Update playlist metadata",
        params: idParam,
        body: UpdatePlaylistBodySchema,
        response: { 200: PlaylistSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => playlistsService.update(req.params.id, req.body),
  );

  r.delete(
    "/:id",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["playlists"],
        summary: "Delete a playlist (cascades to its videos)",
        params: idParam,
        response: {
          200: z.object({ id: z.string(), deleted: z.boolean() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => playlistsService.delete(req.params.id),
  );

  r.post(
    "/:id/videos",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["playlists"],
        summary: "Append a catalog video to a playlist",
        params: idParam,
        body: AddVideoBodySchema,
        response: { 201: PlaylistVideoSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const added = await playlistsService.addVideo(req.params.id, req.body.videoId);
      reply.code(201);
      return added;
    },
  );

  r.delete(
    "/:id/videos/:videoId",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["playlists"],
        summary: "Remove a video entry from a playlist",
        params: playlistVideoParams,
        response: {
          200: z.object({ id: z.string(), deleted: z.boolean() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => playlistsService.removeVideo(req.params.id, req.params.videoId),
  );

  r.post(
    "/:id/reorder",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["playlists"],
        summary: "Reorder a playlist's videos by id",
        params: idParam,
        body: ReorderBodySchema,
        response: { 200: PlaylistDetailSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => playlistsService.reorder(req.params.id, req.body.videoIds),
  );
}
