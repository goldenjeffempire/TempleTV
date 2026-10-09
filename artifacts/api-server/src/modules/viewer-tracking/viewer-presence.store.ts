import { createHash, randomBytes } from "node:crypto";
import { pgPool } from "../../infrastructure/db.js";

export class InvalidViewerCredential extends Error {}
export const credentialHash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Durable leases, not socket counts. Database time is the expiry authority.
 * No Redis/in-memory fallback: loss of the store is an explicit unavailable
 * response, never a fabricated zero. All SQL values are parameterized.
 */
export class ViewerPresenceStore {
  private ready?: Promise<void>;
  constructor(private readonly pool = pgPool, readonly ttlSeconds = 25) {}

  async initialize(): Promise<void> {
    if (!this.ready) {
      this.ready = this.ensureSchema().catch((err) => {
        this.ready = undefined;
        throw err;
      });
    }
    await this.ready;
  }

  private async ensureSchema(): Promise<void> {
    // Idempotent startup migration. Keep these tables mirrored in db/schema.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS viewer_presence_credentials (
      token_hash text PRIMARY KEY, owner_key text NOT NULL, user_id text,
      expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '30 days')
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS viewer_presence_leases (
      token_hash text PRIMARY KEY REFERENCES viewer_presence_credentials(token_hash) ON DELETE CASCADE,
      stream_id text NOT NULL, sequence bigint NOT NULL, active boolean NOT NULL,
      expires_at timestamptz NOT NULL, platform text
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS viewer_presence_active_idx
      ON viewer_presence_leases (stream_id, expires_at) WHERE active = true`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS viewer_presence_live_expiry_idx
      ON viewer_presence_leases (expires_at, stream_id) WHERE active = true`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS viewer_presence_credentials_expiry_idx
      ON viewer_presence_credentials (expires_at)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS viewer_presence_metrics (
      stream_id text PRIMARY KEY, peak integer NOT NULL DEFAULT 0
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS app_presence_leases (
      token_hash text PRIMARY KEY REFERENCES viewer_presence_credentials(token_hash) ON DELETE CASCADE,
      sequence bigint NOT NULL, active boolean NOT NULL, expires_at timestamptz NOT NULL
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS app_presence_live_expiry_idx
      ON app_presence_leases (expires_at) WHERE active = true`);
  }

  async issue(userId?: string, resumeSessionId?: string): Promise<string> {
    await this.initialize();
    const authenticatedOwner = userId ? credentialHash(`user:${userId}`) : null;
    if (resumeSessionId) {
      // Possession proves ownership of this presence-only installation token.
      // Login/logout regroup it instead of creating two active leases for the
      // same phone. Account access still requires independent authentication;
      // userId is supplied by the server principal, never the client payload.
      const result = await this.pool.query(
        `UPDATE viewer_presence_credentials
         SET expires_at = clock_timestamp() + interval '30 days',
             user_id = $2, owner_key = COALESCE($3, token_hash)
         WHERE token_hash = $1
         AND expires_at > clock_timestamp() RETURNING token_hash`,
        [credentialHash(resumeSessionId), userId ?? null, authenticatedOwner],
      );
      if (result.rowCount) return resumeSessionId;
    }
    const token = randomBytes(32).toString("base64url");
    const hash = credentialHash(token);
    // The installation capability identifies a device. Account identity is
    // metadata only: separate devices signed into one account are separate viewers.
    const owner = authenticatedOwner ?? hash;
    await this.pool.query(
      `INSERT INTO viewer_presence_credentials (token_hash, owner_key, user_id) VALUES ($1, $2, $3)`,
      [hash, owner, userId ?? null],
    );
    return token;
  }

  async record(sessionId: string, streamId: string, sequence: number, active: boolean, platform?: string): Promise<{ changed: boolean; isNewSession: boolean }> {
    await this.initialize();
    const result = await this.pool.query(
      `WITH credential AS (
         SELECT token_hash FROM viewer_presence_credentials
         WHERE token_hash = $1 AND expires_at > clock_timestamp()
       ), previous AS (
         SELECT token_hash FROM viewer_presence_leases WHERE token_hash = $1
           AND active = true AND expires_at > clock_timestamp() AND stream_id = $2
       ), updated AS (
         INSERT INTO viewer_presence_leases (token_hash, stream_id, sequence, active, expires_at, platform)
         SELECT token_hash, $2, $3, $4,
           clock_timestamp() + ($5::integer * interval '1 second'), $6 FROM credential
         ON CONFLICT (token_hash) DO UPDATE SET stream_id = EXCLUDED.stream_id,
           sequence = EXCLUDED.sequence, active = EXCLUDED.active,
           expires_at = EXCLUDED.expires_at, platform = EXCLUDED.platform
         WHERE viewer_presence_leases.sequence < EXCLUDED.sequence
         RETURNING token_hash
       ) SELECT EXISTS(SELECT 1 FROM credential) AS valid,
                EXISTS(SELECT 1 FROM updated) AS changed,
                NOT EXISTS(SELECT 1 FROM previous) AS new_session`,
      [credentialHash(sessionId), streamId, sequence, active, this.ttlSeconds, platform ?? null],
    );
    if (!result.rows[0]?.valid) throw new InvalidViewerCredential("Invalid or expired viewer credential");
    // Tombstones retain the sequence after leave. A delayed heartbeat cannot
    // resurrect a paused player or overwrite a newer reconnect/leave request.
    return { changed: Boolean(result.rows[0].changed), isNewSession: active && Boolean(result.rows[0].changed && result.rows[0].new_session) };
  }

  async nextSequence(sessionId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT GREATEST(COALESCE(l.sequence, 0), COALESCE(a.sequence, 0)) + 1 AS sequence
       FROM viewer_presence_credentials c LEFT JOIN viewer_presence_leases l USING (token_hash)
       LEFT JOIN app_presence_leases a USING (token_hash) WHERE c.token_hash = $1`,
      [credentialHash(sessionId)],
    );
    return Number(result.rows[0]?.sequence ?? 1);
  }

  async counts(): Promise<Array<{ streamId: string; current: number; peak: number }>> {
    await this.initialize();
    const result = await this.pool.query(
      `WITH counts AS (
        SELECT l.stream_id, COUNT(DISTINCT c.token_hash)::integer AS current
        FROM viewer_presence_leases l JOIN viewer_presence_credentials c USING (token_hash)
        WHERE l.active = true AND l.expires_at > statement_timestamp()
          AND c.expires_at > statement_timestamp() GROUP BY l.stream_id
      ), peaks AS (
        INSERT INTO viewer_presence_metrics (stream_id, peak) SELECT stream_id, current FROM counts
        ON CONFLICT (stream_id) DO UPDATE SET peak = GREATEST(viewer_presence_metrics.peak, EXCLUDED.peak)
        RETURNING stream_id, peak
      )
      SELECT m.stream_id AS "streamId", COALESCE(c.current, 0)::integer AS current,
        GREATEST(m.peak, COALESCE(c.current, 0), COALESCE(p.peak, 0))::integer AS peak
      FROM viewer_presence_metrics m LEFT JOIN counts c USING (stream_id) LEFT JOIN peaks p USING (stream_id)
      UNION ALL SELECT p.stream_id, c.current, p.peak FROM peaks p JOIN counts c USING (stream_id)
      WHERE NOT EXISTS (SELECT 1 FROM viewer_presence_metrics m WHERE m.stream_id = p.stream_id)`,
    );
    return result.rows;
  }

  async recordApp(sessionId: string, sequence: number, active: boolean): Promise<void> {
    await this.initialize();
    const result = await this.pool.query(
      `WITH credential AS (
        SELECT token_hash FROM viewer_presence_credentials
        WHERE token_hash = $1 AND expires_at > clock_timestamp()
      ), updated AS (
        INSERT INTO app_presence_leases (token_hash, sequence, active, expires_at)
        SELECT token_hash, $2, $3, clock_timestamp() + ($4::integer * interval '1 second') FROM credential
        ON CONFLICT (token_hash) DO UPDATE SET sequence = EXCLUDED.sequence,
          active = EXCLUDED.active, expires_at = EXCLUDED.expires_at
        WHERE app_presence_leases.sequence < EXCLUDED.sequence
        RETURNING token_hash
      ) SELECT EXISTS(SELECT 1 FROM credential) AS valid`,
      [credentialHash(sessionId), sequence, active, this.ttlSeconds],
    );
    if (!result.rows[0]?.valid) throw new InvalidViewerCredential("Invalid or expired app credential");
  }

  async appCount(): Promise<number> {
    await this.initialize();
    const result = await this.pool.query(
      `SELECT COUNT(*)::integer AS current FROM app_presence_leases a
       JOIN viewer_presence_credentials c USING (token_hash)
       WHERE a.active = true AND a.expires_at > statement_timestamp()
         AND c.expires_at > statement_timestamp()`,
    );
    return Number(result.rows[0]?.current ?? 0);
  }

  async prune(): Promise<void> {
    // Indexed, bounded cleanup; avoids a mass deletion holding the pool.
    await this.pool.query(`DELETE FROM viewer_presence_credentials
      WHERE expires_at <= statement_timestamp() AND token_hash IN (
      SELECT token_hash FROM viewer_presence_credentials WHERE expires_at <= statement_timestamp() LIMIT 1000
    )`);
  }
}
