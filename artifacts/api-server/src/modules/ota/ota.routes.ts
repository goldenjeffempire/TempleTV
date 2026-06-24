/**
 * OTA Update Routes
 *
 * Provides admin-triggered Expo EAS Over-The-Air update dispatch via the
 * GitHub Actions workflow_dispatch API and EAS update history via the
 * Expo GraphQL API.
 *
 * Admin (admin role):
 *   GET  /admin/ota/status   — EAS config health + recent updates per channel
 *   POST /admin/ota/publish  — dispatch the ota-update.yml workflow
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth } from "../../middleware/auth.js";
import { env } from "../../config/env.js";
import { logger as rootLogger } from "../../infrastructure/logger.js";

const logger = rootLogger.child({ module: "ota" });

const _429 = z.object({ error: z.string() });

// ── Constants ─────────────────────────────────────────────────────────────────

const EAS_GRAPHQL_URL = "https://api.expo.dev/graphql";
const EXPO_APP_ID     = "61120cd7-966a-4e50-a4c1-2d9f8674bcea";
const GITHUB_API_BASE = "https://api.github.com";
const OTA_WORKFLOW    = "ota-update.yml";

// Channels that have corresponding EAS build profiles.
const KNOWN_CHANNELS = [
  "production",
  "staging",
  "preview",
  "firetv",
  "androidtv",
  "appletv",
] as const;
type Channel = (typeof KNOWN_CHANNELS)[number];

// ── EAS GraphQL helpers ───────────────────────────────────────────────────────

interface EasUpdate {
  id:             string;
  group:          string;
  message:        string | null;
  createdAt:      string;
  runtimeVersion: string;
  platform:       string;
  actor:          { username?: string; firstName?: string } | null;
}

interface EasBranch {
  id:      string;
  name:    string;
  updates: EasUpdate[];
}

async function fetchEasUpdates(token: string): Promise<EasBranch[]> {
  const query = /* graphql */ `
    query GetBranches($appId: String!, $limit: Int!) {
      app {
        byId(appId: $appId) {
          updateBranches(limit: 20) {
            id
            name
            updates(limit: $limit) {
              id
              group
              message
              createdAt
              runtimeVersion
              platform
              actor {
                ... on UserActor  { username }
                ... on RobotActor { firstName }
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetch(EAS_GRAPHQL_URL, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
      "expo-sdk-version": "latest",
    },
    body: JSON.stringify({
      query,
      variables: { appId: EXPO_APP_ID, limit: 5 },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`EAS API ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    data?: { app?: { byId?: { updateBranches?: EasBranch[] } } };
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }

  return json.data?.app?.byId?.updateBranches ?? [];
}

// ── GitHub Actions dispatch ───────────────────────────────────────────────────

async function dispatchWorkflow(opts: {
  repo:    string;
  token:   string;
  channel: Channel;
  message: string;
}): Promise<void> {
  const url = `${GITHUB_API_BASE}/repos/${opts.repo}/actions/workflows/${OTA_WORKFLOW}/dispatches`;

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Accept":               "application/vnd.github+json",
      "Authorization":        `Bearer ${opts.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type":         "application/json",
    },
    body: JSON.stringify({
      ref:    "main",
      inputs: {
        channel: opts.channel,
        message: opts.message,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`);
  }
}

// ── Recent workflow runs ───────────────────────────────────────────────────────

interface WorkflowRun {
  id:          number;
  name:        string;
  status:      string;
  conclusion:  string | null;
  html_url:    string;
  created_at:  string;
  updated_at:  string;
  head_commit: { message: string } | null;
}

async function fetchWorkflowRuns(opts: {
  repo:  string;
  token: string;
}): Promise<WorkflowRun[]> {
  const url = `${GITHUB_API_BASE}/repos/${opts.repo}/actions/workflows/${OTA_WORKFLOW}/runs?per_page=10`;
  const res = await fetch(url, {
    headers: {
      "Accept":               "application/vnd.github+json",
      "Authorization":        `Bearer ${opts.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { workflow_runs?: WorkflowRun[] };
  return json.workflow_runs ?? [];
}

// ── Route registration ─────────────────────────────────────────────────────────

export async function otaRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  // GET /admin/ota/status
  // Returns EAS config health and recent updates per known channel.
  api.get(
    "/admin/ota/status",
    {
      schema: {
        tags:     ["ota"],
        summary:  "OTA update configuration status and recent update history",
        response: {
          200: z.object({
            configured: z.object({
              expoToken:  z.boolean(),
              github:     z.boolean(),
              githubRepo: z.string().nullable(),
            }),
            branches:      z.array(z.object({
              id:      z.string(),
              name:    z.string(),
              updates: z.array(z.object({
                id:             z.string(),
                group:          z.string(),
                message:        z.string().nullable(),
                createdAt:      z.string(),
                runtimeVersion: z.string(),
                platform:       z.string(),
                actor:          z.string().nullable(),
              })),
            })),
            workflowRuns:  z.array(z.object({
              id:         z.number(),
              name:       z.string(),
              status:     z.string(),
              conclusion: z.string().nullable(),
              html_url:   z.string(),
              created_at: z.string(),
              updated_at: z.string(),
              message:    z.string().nullable(),
            })),
            error: z.string().nullable(),
          }),
          429: _429,
        },
      },
      preHandler: requireAuth("editor"),
    },
    async (_req, reply) => {
      const expoToken  = env.EXPO_ACCESS_TOKEN;
      const ghToken    = env.GITHUB_TOKEN;
      const ghRepo     = env.GITHUB_REPO ?? null;

      const configured = {
        expoToken:  !!expoToken,
        github:     !!(ghToken && ghRepo),
        githubRepo: ghRepo,
      };

      let branches: EasBranch[]    = [];
      let workflowRuns: WorkflowRun[] = [];
      let error: string | null     = null;

      // Fetch EAS update history
      if (expoToken) {
        try {
          const raw = await fetchEasUpdates(expoToken);
          // Only return branches that match our known channels
          const channelSet = new Set<string>(KNOWN_CHANNELS);
          branches = raw
            .filter((b) => channelSet.has(b.name))
            .map((b) => ({
              ...b,
              updates: b.updates.map((u) => ({
                ...u,
                actor: u.actor?.username ?? u.actor?.firstName ?? null,
              })),
            }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err }, "ota: failed to fetch EAS updates");
          error = `EAS API error: ${msg}`;
        }
      }

      // Fetch recent GitHub Actions runs
      if (ghToken && ghRepo) {
        try {
          const runs = await fetchWorkflowRuns({ repo: ghRepo, token: ghToken });
          workflowRuns = runs.map((r) => ({
            id:         r.id,
            name:       r.name,
            status:     r.status,
            conclusion: r.conclusion,
            html_url:   r.html_url,
            created_at: r.created_at,
            updated_at: r.updated_at,
            message:    r.head_commit?.message ?? null,
          }));
        } catch (err) {
          logger.warn({ err }, "ota: failed to fetch GitHub workflow runs");
        }
      }

      return reply.send({
        configured,
        branches,
        workflowRuns,
        error,
      });
    },
  );

  // POST /admin/ota/publish
  // Triggers the ota-update.yml GitHub Actions workflow via workflow_dispatch.
  api.post(
    "/admin/ota/publish",
    {
      schema: {
        tags:    ["ota"],
        summary: "Trigger an OTA update for a specific channel",
        body: z.object({
          channel: z.enum(KNOWN_CHANNELS),
          message: z.string().min(1).max(500),
        }),
        response: {
          200: z.object({ ok: z.boolean(), queued: z.boolean(), note: z.string() }),
          400: z.object({ error: z.string() }),
          503: z.object({ error: z.string() }),
          429: _429,
        },
      },
      preHandler: requireAuth("admin"),
    },
    async (req, reply) => {
      const { channel, message } = req.body;
      const ghToken = env.GITHUB_TOKEN;
      const ghRepo  = env.GITHUB_REPO;

      if (!ghToken || !ghRepo) {
        return reply.code(503).send({
          error:
            "GITHUB_TOKEN and GITHUB_REPO must be configured to trigger OTA updates. " +
            "Set them in the Render environment variables or Replit Secrets.",
        });
      }

      try {
        await dispatchWorkflow({ repo: ghRepo, token: ghToken, channel, message });

        logger.info(
          { channel, message, triggeredBy: (req as { user?: { email?: string } }).user?.email ?? "admin" },
          "ota: workflow dispatch sent",
        );

        return reply.send({
          ok:     true,
          queued: true,
          note:   `OTA update queued for channel "${channel}". GitHub Actions will bundle and publish the update within ~3 minutes. Monitor progress in the Workflow Runs panel.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, channel }, "ota: failed to dispatch workflow");
        return reply.code(503).send({
          error: `Failed to trigger GitHub Actions workflow: ${msg}`,
        });
      }
    },
  );
}
