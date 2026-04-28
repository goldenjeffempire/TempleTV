import { z } from "zod";

/**
 * Strongly-typed, validated environment. All env access in the
 * application MUST flow through `env`. New variables go here.
 */
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be ≥32 chars"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be ≥32 chars"),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  ADMIN_API_TOKEN: z.string().min(16).optional(),

  CORS_ORIGINS: z.string().default("*"),

  REDIS_URL: z.string().optional(),

  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true")
    .default(false),
  S3_PUBLIC_URL_BASE: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  BROADCAST_PRELOAD_LEAD_MS: z.coerce.number().int().nonnegative().default(15_000),
  BROADCAST_FAILOVER_HLS_URL: z.string().optional(),

  RATE_LIMIT_DEFAULT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(20),

  SENTRY_DSN: z.string().optional(),
});

export type AppEnv = z.infer<typeof Env>;

function loadEnv(): AppEnv {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    console.error(`[config] Environment validation failed:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env: AppEnv = loadEnv();

export function isProd(): boolean {
  return env.NODE_ENV === "production";
}
