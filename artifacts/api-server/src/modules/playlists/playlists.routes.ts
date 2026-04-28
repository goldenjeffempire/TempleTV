import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
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
      schema: {
        tags: ["playlists"],
        summary: "List all playlists with video counts",
        response: { 200: ListPlaylistsResponseSchema },
      },
    },
    async () => playlistsService.list(),
  );

  r.get(
    "/:id",
    {
      schema: {
        tags: ["playlists"],
        summary: "Get a single playlist with its ordered video list",
        params: idParam,
        response: { 200: PlaylistDetailSchema },
      },
    },
    async (req) => playlistsService.getById(req.params.id),
  );

  r.post(
    "/",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["playlists"],
        summary: "Create a new playlist",
        body: CreatePlaylistBodySchema,
        response: { 201: PlaylistSchema },
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
      schema: {
        tags: ["playlists"],
        summary: "Update playlist metadata",
        params: idParam,
        body: UpdatePlaylistBodySchema,
        response: { 200: PlaylistSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => playlistsService.update(req.params.id, req.body),
  );

  r.delete(
    "/:id",
    {
      preHandler: requireAuth("admin"),
      schema: {
        tags: ["playlists"],
        summary: "Delete a playlist (cascades to its videos)",
        params: idParam,
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => playlistsService.delete(req.params.id),
  );

  r.post(
    "/:id/videos",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["playlists"],
        summary: "Append a catalog video to a playlist",
        params: idParam,
        body: AddVideoBodySchema,
        response: { 201: PlaylistVideoSchema },
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
      schema: {
        tags: ["playlists"],
        summary: "Remove a video entry from a playlist",
        params: playlistVideoParams,
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => playlistsService.removeVideo(req.params.id, req.params.videoId),
  );

  r.post(
    "/:id/reorder",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["playlists"],
        summary: "Reorder a playlist's videos by id",
        params: idParam,
        body: ReorderBodySchema,
        response: { 200: PlaylistDetailSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => playlistsService.reorder(req.params.id, req.body.videoIds),
  );
}
