import { promises as fs } from "fs";
import { Readable } from "stream";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { db, videosTable, transcodingJobsTable, broadcastQueueTable } from "@workspace/db";
import { eq, and, desc, asc, or, isNull, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { broadcastLiveEvent } from "./liveEvents";
import { cache } from "./cache";
import { invalidatePublicVideoCaches } from "./publicCacheInvalidation";
import { emitBroadcastState } from "../routes/broadcast";
import { isS3Configured, putObject } from "./s3Storage";
import { createReadStream } from "fs";
import {
  runFfmpeg,
  validateAndProbeInput,
  assertFfmpegAvailable,
  isFfmpegReady,
  TerminalTranscodeError,
} from "./ffmpeg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const HLS_DIR = path.join(UPLOADS_DIR, "hls");
// HLS output is uploaded to S3 when AWS_S3_BUCKET (+ credentials) is set.
const S3_UPLOAD_ENABLED = isS3Configured();

interface QualityProfile {
  name: string;
  height: number;
  videoBitrate: string;
  maxBitrate: string;
  bufsize: string;
  audioBitrate: string;
  bandwidth: number;
  resolution: string;
}

// 4-level adaptive bitrate ladder — 240p to 720p
// 1080p was removed because the production container's memory budget on the
// current Render tier is insufficient for ffmpeg 1080p H.264 encodes — they
// were OOM-killing the API process and triggering a server-wide crash loop
// (see Round 4o in replit.md). 720p remains the top variant; bump back to
// 1080p once the API service has been moved to a tier with more RAM.
// 2-second HLS segments ensure <3 s startup time
const QUALITY_PROFILES: QualityProfile[] = [
  {
    name: "720p",
    height: 720,
    videoBitrate: "2500k",
    maxBitrate: "2800k",
    bufsize: "5600k",
    audioBitrate: "128k",
    bandwidth: 2500000,
    resolution: "1280x720",
  },
  {
    name: "480p",
    height: 480,
    videoBitrate: "1200k",
    maxBitrate: "1400k",
    bufsize: "2800k",
    audioBitrate: "96k",
    bandwidth: 1200000,
    resolution: "854x480",
  },
  {
    name: "360p",
    height: 360,
    videoBitrate: "600k",
    maxBitrate: "700k",
    bufsize: "1400k",
    audioBitrate: "64k",
    bandwidth: 600000,
    resolution: "640x360",
  },
  {
    name: "240p",
    height: 240,
    videoBitrate: "280k",
    maxBitrate: "320k",
    bufsize: "640k",
    audioBitrate: "48k",
    bandwidth: 280000,
    resolution: "426x240",
  },
];

/**
 * Pick the correct HLS CODECS string for an H.264 Main-Profile rendition.
 * Each variant in the master manifest must declare a codec string whose AVC
 * level can actually contain the rendition's coded picture size (rounded
 * up to 16-px macroblocks). Advertising Level 3.1 for a 1080p variant
 * triggers strict players to reject it with: "coded area exceeds maximum
 * coded area supported by the AVC level".
 *
 * We encode every variant with `-profile:v main -level:v 4.1`, but the
 * declared codec must reflect the rendition's resolution so that bitrate-
 * adaptive players negotiate it correctly on hardware-limited devices.
 *
 * Reference: ITU-T H.264 Annex A, Table A-1.
 */
function avcMainCodecForResolution(width: number, height: number, fps = 30): string {
  const mbW = Math.ceil(Math.max(1, width) / 16);
  const mbH = Math.ceil(Math.max(1, height) / 16);
  const codedArea = mbW * 16 * mbH * 16;
  const mbps = mbW * mbH * Math.max(1, fps);
  const levels: Array<[number, number, string]> = [
    [  414720,   40500, "1e"], // 3.0
    [  921600,  108000, "1f"], // 3.1
    [ 1310720,  216000, "20"], // 3.2
    [ 2097152,  245760, "28"], // 4.0
    [ 2097152,  245760, "29"], // 4.1
    [ 2228224,  522240, "2a"], // 4.2
    [ 5652480,  589824, "32"], // 5.0
    [ 9437184,  983040, "33"], // 5.1
    [ 9437184, 2073600, "34"], // 5.2
  ];
  for (const [area, rate, hex] of levels) {
    if (codedArea <= area && mbps <= rate) return `avc1.4d40${hex}`;
  }
  return "avc1.4d4034";
}

function parseResolution(resolution: string): { width: number; height: number } {
  const [w, h] = resolution.split("x").map((n) => parseInt(n, 10));
  return { width: Number.isFinite(w) ? w : 0, height: Number.isFinite(h) ? h : 0 };
}

function parseDurationToSeconds(dur: string): number {
  const match = dur.match(/(\d+):(\d+):(\d+\.?\d*)/);
  if (!match) return 0;
  return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
}

async function transcodeQuality(
  inputPath: string,
  outputDir: string,
  profile: QualityProfile,
  sourceHeight: number,
  sourceDurationSec: number,
  onProgress?: (pct: number) => void
): Promise<boolean> {
  // Skip profiles higher than source (no upscaling)
  if (sourceHeight > 0 && profile.height > sourceHeight * 1.1) {
    logger.info({ profile: profile.name, sourceHeight }, "Skipping upscale variant");
    return false;
  }

  await fs.mkdir(outputDir, { recursive: true });

  const segmentPattern = path.join(outputDir, "seg%05d.ts");
  const playlistPath = path.join(outputDir, "index.m3u8");

  // ── ffmpeg memory containment ──────────────────────────────────────────────
  // x264 spawns one lookahead/encoder worker per CPU thread (`-threads 0` =
  // auto). Each worker holds its own per-frame work buffers, and the lookahead
  // ring grows roughly linearly with thread count. On a 512MB Render container
  // the API process baselines at ~150-200MB; an unbounded ffmpeg encode peaks
  // at 350-450MB which trips the OOM killer (Render Events: "Ran out of memory
  // (used over 512MB)" — see Round 4 in replit.md). Capping `-threads` slashes
  // peak ffmpeg RSS by ~40-60% with a small (~15-20%) wall-clock penalty.
  // Configurable via `FFMPEG_THREADS` so a higher Render tier can crank it back
  // up without a code change. Default 2 = sweet spot for 512MB-1GB containers.
  const ffmpegThreads = (() => {
    const raw = process.env.FFMPEG_THREADS;
    if (!raw) return 2;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 16 ? n : 2;
  })();

  const args = [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",    // optional audio (won't fail if no audio)
    "-threads", String(ffmpegThreads),
    "-vf", `scale=-2:'min(${profile.height},ih)'`,
    "-c:v", "libx264",
    "-preset", "fast",
    "-profile:v", "main",
    "-level:v", "4.1",
    "-b:v", profile.videoBitrate,
    "-maxrate", profile.maxBitrate,
    "-bufsize", profile.bufsize,
    "-g", "60",           // 2-second GOP at 30fps → fast random access
    "-keyint_min", "60",
    "-sc_threshold", "0", // disable scene-change keyframes (consistent GOP)
    // Cap the x264 lookahead ring depth. Default is 40 frames × thread-count;
    // on a memory-tight tier we'd rather give back ~5% encode efficiency than
    // OOM. `rc-lookahead=20` keeps rate control tight without ballooning RSS.
    "-x264-params", "rc-lookahead=20:sync-lookahead=0",
    "-c:a", "aac",
    "-b:a", profile.audioBitrate,
    "-ar", "48000",
    "-ac", "2",
    "-hls_time", "2",                    // 2-second segments → <3 s startup
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", segmentPattern,
    "-hls_flags", "independent_segments+delete_segments",
    "-hls_list_size", "0",
    playlistPath,
  ];

  // Wall-clock cap: generous 20× source duration, floored at 5 min, ceilinged
  // at 4 h. Idle watchdog: 90 s of silence kills the process.
  const wallClockMs = Math.min(
    4 * 60 * 60 * 1000,
    Math.max(5 * 60 * 1000, Math.ceil(sourceDurationSec * 20) * 1000),
  );

  await runFfmpeg({
    args,
    onProgress,
    idleTimeoutMs: 90_000,
    maxWallClockMs: wallClockMs,
  });
  return true;
}

async function generateMasterPlaylist(
  hlsVideoDir: string,
  producedProfiles: QualityProfile[]
): Promise<void> {
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "",
  ];

  for (const profile of producedProfiles) {
    const playlistPath = path.join(hlsVideoDir, profile.name, "index.m3u8");
    try {
      await fs.access(playlistPath);
      const { width, height } = parseResolution(profile.resolution);
      const videoCodec = avcMainCodecForResolution(width, height, 30);
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bandwidth},RESOLUTION=${profile.resolution},CODECS="${videoCodec},mp4a.40.2",NAME="${profile.name}"`
      );
      lines.push(`${profile.name}/index.m3u8`);
      lines.push("");
    } catch {
      logger.warn({ profile: profile.name }, "Quality variant missing, skipping in master playlist");
    }
  }

  const masterPath = path.join(hlsVideoDir, "master.m3u8");
  await fs.writeFile(masterPath, lines.join("\n"), "utf-8");
}

// ── S3 upload (best-effort, non-blocking for serving) ────────────────────────
async function uploadHlsToS3(videoId: string, localHlsDir: string): Promise<void> {
  if (!S3_UPLOAD_ENABLED) return;

  try {
    const allFiles = await collectFiles(localHlsDir);

    await Promise.all(
      allFiles.map(async (localPath) => {
        const relative = path.relative(localHlsDir, localPath);
        const objectName = `hls/${videoId}/${relative}`;
        const contentType = localPath.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/mp2t";

        await putObject(objectName, createReadStream(localPath), {
          contentType,
          // HLS playlists rotate frequently; segments are immutable once
          // produced. Let the client/CDN cache segments aggressively.
          cacheControl: localPath.endsWith(".m3u8")
            ? "public, max-age=30"
            : "public, max-age=3600, immutable",
        });
      })
    );

    logger.info({ videoId, fileCount: allFiles.length }, "HLS output uploaded to S3");
  } catch (err) {
    logger.warn({ videoId, err }, "S3 HLS upload failed (local serving still active)");
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...await collectFiles(full));
    else results.push(full);
  }
  return results;
}

// ── Job processor ─────────────────────────────────────────────────────────────

let isWorkerRunning = false;

// Backoff schedule for auto-retry: 30 s → 1 min → 2 min (2^n × 30s).
function backoffDelayMs(attempt: number): number {
  return Math.min(15 * 60 * 1000, 30_000 * Math.pow(2, Math.max(0, attempt - 1)));
}

async function processNextJob(): Promise<boolean> {
  // Hard-gate on ffmpeg readiness. If the binaries weren't verified at boot,
  // try once more here lazily; if still missing, exit early WITHOUT touching
  // the queue (so attempts aren't burned on infrastructure failures).
  if (!isFfmpegReady()) {
    try {
      await assertFfmpegAvailable();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Skipping job processing — ffmpeg unavailable",
      );
      return false;
    }
  }

  // ── Memory-aware backpressure ────────────────────────────────────────────
  // ffmpeg is a child process with its own RSS, so checking *Node's* RSS is
  // not a perfect proxy for container memory — but it's the only signal we
  // have without shelling out, and BETWEEN jobs (when no encoder is running)
  // Node is the dominant consumer. If our own RSS is already pushing the
  // OOM ceiling, spawning ffmpeg is guaranteed to crash the container, take
  // down the API, and reset every viewer's broadcast stream. Better to skip
  // the job — the retry tick will pick it up again in 30s, by which time
  // ffmpeg from the previous job has exited and freed its pages back to the
  // OS. Threshold defaults to 380MB (≈75% of a 512MB Render container) and
  // is configurable via `MAX_NODE_RSS_MB_BEFORE_TRANSCODE` for ops tuning.
  const memoryCeilingMb = (() => {
    const raw = process.env.MAX_NODE_RSS_MB_BEFORE_TRANSCODE;
    if (!raw) return 380;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 380;
  })();
  const rssBytes = process.memoryUsage().rss;
  const rssMb = Math.round(rssBytes / 1024 / 1024);
  if (rssMb > memoryCeilingMb) {
    logger.warn(
      { rssMb, ceilingMb: memoryCeilingMb },
      "Skipping transcode claim — Node RSS above safety ceiling, deferring to retry tick",
    );
    return false;
  }

  // Atomically claim the next eligible job using PostgreSQL's
  // FOR UPDATE SKIP LOCKED — the canonical job-queue pattern. This
  // eliminates the SELECT-then-UPDATE race so multiple workers (or
  // multiple instances) can never claim the same row.
  const claimed = await db.execute<{
    id: string;
    video_id: string;
    video_path: string;
    attempts: number;
    max_attempts: number;
  }>(sql`
    UPDATE transcoding_jobs
    SET status       = 'processing',
        started_at   = NOW(),
        progress     = 0,
        attempts     = attempts + 1,
        next_retry_at = NULL
    WHERE id = (
      SELECT id FROM transcoding_jobs
      WHERE status = 'queued'
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, video_id, video_path, attempts, max_attempts
  `);

  const claimedRow = (claimed as unknown as { rows?: Array<{
    id: string;
    video_id: string;
    video_path: string;
    attempts: number;
    max_attempts: number;
  }> }).rows ?? (claimed as unknown as Array<{
    id: string;
    video_id: string;
    video_path: string;
    attempts: number;
    max_attempts: number;
  }>);

  const claimedJob = Array.isArray(claimedRow) ? claimedRow[0] : undefined;
  if (!claimedJob) return false;

  const job = {
    id: claimedJob.id,
    videoId: claimedJob.video_id,
    videoPath: claimedJob.video_path,
    attempts: claimedJob.attempts,
    maxAttempts: claimedJob.max_attempts,
  };
  const attemptNumber = job.attempts;

  logger.info(
    { jobId: job.id, videoId: job.videoId, attempt: attemptNumber, max: job.maxAttempts },
    "Starting transcoding job",
  );

  await db
    .update(videosTable)
    .set({ transcodingStatus: "processing" })
    .where(eq(videosTable.id, job.videoId));

  broadcastLiveEvent("transcoding-update", {
    jobId: job.id,
    videoId: job.videoId,
    status: "processing",
    progress: 0,
    attempt: attemptNumber,
  });

  // Track any temp file we download so we can clean it up afterwards.
  let tempDownloadPath: string | null = null;

  try {
    const hlsVideoDir = path.join(HLS_DIR, job.videoId);
    await fs.mkdir(hlsVideoDir, { recursive: true });

    // ── Source-file resilience ──────────────────────────────────────────────
    // The `video_path` column records the local filesystem path at the moment
    // of upload. When the server migrates environments (e.g. Render → Replit)
    // that path no longer exists.  Before giving up, check whether the video
    // row's `localVideoUrl` is an HTTP URL we can fetch, download it to a tmp
    // file, and use that for encoding instead.
    let effectivePath = job.videoPath;

    const localAccessible = await fs.access(job.videoPath).then(() => true).catch(() => false);
    if (!localAccessible) {
      logger.warn(
        { jobId: job.id, videoPath: job.videoPath },
        "Source file not found at recorded path — attempting HTTP fallback",
      );

      const videoRows = await db
        .select({ localVideoUrl: videosTable.localVideoUrl })
        .from(videosTable)
        .where(eq(videosTable.id, job.videoId))
        .limit(1);

      const localVideoUrl = videoRows[0]?.localVideoUrl;

      if (!localVideoUrl || !/^https?:\/\//.test(localVideoUrl)) {
        throw new Error(
          `Input file inaccessible: ENOENT: no such file or directory, stat '${job.videoPath}' (no HTTP fallback URL available)`,
        );
      }

      const tmpDir = path.join(UPLOADS_DIR, "tmp");
      await fs.mkdir(tmpDir, { recursive: true });
      tempDownloadPath = path.join(tmpDir, `dl-${job.id}.mp4`);

      logger.info({ jobId: job.id, url: localVideoUrl, dest: tempDownloadPath }, "Downloading source file for transcoding");

      const response = await fetch(localVideoUrl);
      if (!response.ok || !response.body) {
        throw new Error(`HTTP fallback download failed: ${response.status} ${response.statusText} — ${localVideoUrl}`);
      }

      const dest = await fs.open(tempDownloadPath, "w");
      const writer = dest.createWriteStream();
      const reader = response.body;

      await new Promise<void>((resolve, reject) => {
        const readable = (Readable as any).fromWeb
          ? (Readable as any).fromWeb(reader as any)
          : (reader as any);
        readable.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
        readable.on("error", reject);
      });

      await dest.close();
      effectivePath = tempDownloadPath;

      logger.info({ jobId: job.id, dest: tempDownloadPath }, "Source file downloaded successfully");
    }

    // Strict input validation — fail fast with a clear reason if the source
    // is corrupt, unsupported, or missing a video stream.
    const probed = await validateAndProbeInput(effectivePath);
    const sourceHeight = probed.height;
    const sourceDurationSec = probed.durationSec;

    const producedProfiles: QualityProfile[] = [];
    const variantFailures: Array<{ profile: string; error: string }> = [];

    for (let i = 0; i < QUALITY_PROFILES.length; i++) {
      const profile = QUALITY_PROFILES[i]!;
      const qualityOutputDir = path.join(hlsVideoDir, profile.name);

      logger.info({ jobId: job.id, quality: profile.name }, "Transcoding quality variant");

      const profileBaseProgress = Math.round((i / QUALITY_PROFILES.length) * 100);
      const profileProgressRange = Math.round(100 / QUALITY_PROFILES.length);

      let lastBroadcastPct = -1;

      // Per-variant fallback: a single quality failure is logged and skipped;
      // the job only fails if ZERO variants are produced.
      try {
        const produced = await transcodeQuality(
          effectivePath,
          qualityOutputDir,
          profile,
          sourceHeight,
          sourceDurationSec,
          async (pct) => {
            const overall = profileBaseProgress + Math.round((pct / 100) * profileProgressRange);
            await db
              .update(transcodingJobsTable)
              .set({ progress: overall })
              .where(eq(transcodingJobsTable.id, job.id));

            if (overall - lastBroadcastPct >= 3) {
              lastBroadcastPct = overall;
              broadcastLiveEvent("transcoding-update", {
                jobId: job.id,
                videoId: job.videoId,
                status: "processing",
                progress: overall,
              });
            }
          },
        );

        if (produced) producedProfiles.push(profile);
      } catch (variantErr) {
        const errMsg = variantErr instanceof Error ? variantErr.message : String(variantErr);
        logger.warn(
          { jobId: job.id, profile: profile.name, err: errMsg },
          "Variant transcode failed — skipping this quality and continuing",
        );
        variantFailures.push({ profile: profile.name, error: errMsg });
        // Clean partial output so the master playlist doesn't reference it.
        await fs.rm(qualityOutputDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (producedProfiles.length === 0) {
      const summary = variantFailures
        .map((v) => `${v.profile}: ${v.error}`)
        .join(" | ")
        .slice(0, 1000);
      throw new Error(
        `All ${QUALITY_PROFILES.length} quality variants failed${summary ? ` — ${summary}` : ""}`,
      );
    }

    await generateMasterPlaylist(hlsVideoDir, producedProfiles);

    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    const baseUrl = process.env.API_BASE_URL ?? (devDomain ? `https://${devDomain}` : "");
    const hlsMasterUrl = `${baseUrl}/api/hls/${job.videoId}/master.m3u8`;

    const probedDuration = Math.round(sourceDurationSec);
    const partialNote =
      variantFailures.length > 0
        ? `Partial: produced ${producedProfiles.length}/${QUALITY_PROFILES.length} variants (skipped ${variantFailures.map((v) => v.profile).join(", ")})`
        : null;

    await db
      .update(transcodingJobsTable)
      .set({
        status: "done",
        progress: 100,
        completedAt: new Date(),
        errorMessage: partialNote,
      })
      .where(eq(transcodingJobsTable.id, job.id));

    const videoUpdates: Partial<typeof videosTable.$inferInsert> = {
      transcodingStatus: "done",
      hlsMasterUrl,
    };
    if (probedDuration > 0) {
      videoUpdates.duration = String(probedDuration);
    }

    await db
      .update(videosTable)
      .set(videoUpdates)
      .where(eq(videosTable.id, job.videoId));

    await db
      .update(broadcastQueueTable)
      .set({
        localVideoUrl: hlsMasterUrl,
        videoSource: "local",
        ...(probedDuration > 0 ? { durationSecs: probedDuration } : {}),
      })
      .where(eq(broadcastQueueTable.videoId, job.videoId));

    // Clear the full broadcast cache surface — not just `broadcast:queue` —
    // so the next /api/broadcast/current build re-reads the freshly-updated
    // queue row (with the new HLS URL + probed duration) instead of serving
    // a stale `broadcast:current_payload` snapshot. Without this, clients
    // could see an "Now Playing" entry whose `localVideoUrl` is still null
    // for up to the payload TTL after transcoding completed.
    await Promise.all([
      cache.del("broadcast:queue"),
      cache.del("broadcast:current_payload"),
    ]);
    // The public /api/videos/featured and /api/videos/trending payloads
    // include `transcodingStatus` and `hlsMasterUrl`. Invalidate them so the
    // newly playable HLS link is visible on the next request rather than
    // waiting for the 60s TTL boundary.
    await invalidatePublicVideoCaches();

    logger.info(
      {
        jobId: job.id,
        videoId: job.videoId,
        hlsMasterUrl,
        variants: producedProfiles.map((p) => p.name),
        skipped: variantFailures.map((v) => v.profile),
      },
      "Transcoding complete",
    );

    broadcastLiveEvent("transcoding-update", {
      jobId: job.id,
      videoId: job.videoId,
      status: "done",
      progress: 100,
      hlsMasterUrl,
    });
    broadcastLiveEvent("broadcast-queue-updated", {
      videoId: job.videoId,
      hlsMasterUrl,
      durationSecs: probedDuration > 0 ? probedDuration : undefined,
      queuedAt: new Date().toISOString(),
    });
    // Push a fresh "Now Playing" payload to every connected client. If the
    // just-transcoded video happens to be the on-air item, this guarantees
    // its `localVideoUrl` flips from null → real HLS URL on TV/mobile/admin
    // surfaces the moment encoding finishes — no waiting for poll cycles or
    // a future queue mutation. emitBroadcastState rebuilds the payload from
    // the now-invalidated cache and re-broadcasts via SSE.
    emitBroadcastState("queue-item-transcoded", {
      videoId: job.videoId,
      hlsMasterUrl,
    });

    // Upload HLS output to GCS for CDN-backed durability (non-blocking)
    uploadHlsToS3(job.videoId, hlsVideoDir).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Terminal errors (corrupt input, no video stream, etc.) skip retries —
    // re-running the encoder against the same broken file would just fail
    // identically and burn through the retry budget.
    const isTerminal = err instanceof TerminalTranscodeError;
    const willRetry = !isTerminal && attemptNumber < job.maxAttempts;

    if (willRetry) {
      const delayMs = backoffDelayMs(attemptNumber);
      const retryAt = new Date(Date.now() + delayMs);
      logger.warn(
        { jobId: job.id, attempt: attemptNumber, max: job.maxAttempts, retryAt, err: msg },
        "Transcoding attempt failed — scheduling auto-retry",
      );

      await db
        .update(transcodingJobsTable)
        .set({
          status: "queued",
          progress: 0,
          errorMessage: `Attempt ${attemptNumber}/${job.maxAttempts} failed: ${msg}`,
          startedAt: null,
          nextRetryAt: retryAt,
        })
        .where(eq(transcodingJobsTable.id, job.id));

      await db
        .update(videosTable)
        .set({ transcodingStatus: "queued" })
        .where(eq(videosTable.id, job.videoId));

      broadcastLiveEvent("transcoding-update", {
        jobId: job.id,
        videoId: job.videoId,
        status: "queued",
        attempt: attemptNumber,
        nextRetryAt: retryAt.toISOString(),
        error: msg,
      });
    } else {
      logger.error(
        { jobId: job.id, attempt: attemptNumber, err: msg },
        "Transcoding job permanently failed (max attempts exhausted)",
      );

      await db
        .update(transcodingJobsTable)
        .set({
          status: "failed",
          errorMessage: `Failed after ${attemptNumber} attempts: ${msg}`,
          completedAt: new Date(),
        })
        .where(eq(transcodingJobsTable.id, job.id));

      await db
        .update(videosTable)
        .set({ transcodingStatus: "failed" })
        .where(eq(videosTable.id, job.videoId));

      broadcastLiveEvent("transcoding-update", {
        jobId: job.id,
        videoId: job.videoId,
        status: "failed",
        error: msg,
      });
    }
  } finally {
    // Clean up any temporary file we downloaded for HTTP fallback transcoding.
    if (tempDownloadPath) {
      fs.rm(tempDownloadPath, { force: true }).catch(() => {});
    }
  }

  return true;
}

async function startWorker(): Promise<void> {
  if (isWorkerRunning) return;
  isWorkerRunning = true;

  try {
    let hadWork = true;
    while (hadWork) {
      hadWork = await processNextJob();
    }
  } finally {
    isWorkerRunning = false;
    logger.info("Transcoding worker idle — queue empty");
  }
}

// ── Retry tick ────────────────────────────────────────────────────────────────
// Wake every 30 s and run the worker if there are queued jobs (including
// auto-retry jobs whose backoff has elapsed). This is what makes scheduled
// retries actually fire without requiring a new upload to trigger them.
let retryTickHandle: NodeJS.Timeout | null = null;

// ── Worker liveness heartbeat ────────────────────────────────────────────────
// Written to the distributed cache (Postgres-backed) on every retry tick and
// after every job ticks the worker. The API process reads this to derive
// "is the transcoder worker alive?" without needing direct IPC. Surfaced by
// `GET /api/admin/process-status` for the Live Monitor.
export const TRANSCODER_HEARTBEAT_KEY = "process:transcoder:heartbeat";
const TRANSCODER_HEARTBEAT_TTL_MS = 120_000; // 2× the retry tick

export interface TranscoderHeartbeat {
  pid: number;
  ts: number;          // epoch ms
  runMode: string;     // "worker" | "all"
  nodeVersion: string;
  rssMb: number;
  uptimeSec: number;
  // True once the worker startup self-check guardrail (see index.ts) has
  // confirmed the event loop has ref'd handles. Surfaced in Mission Control
  // so operators can see at a glance that the worker survived the
  // silent-exit window — not just "alive" but "self-check passed".
  guardrailPassed: boolean;
}

// Module-level latch flipped by `markWorkerGuardrailPassed()`. Stays false
// until the index.ts guardrail timer fires successfully ~2s after boot.
let workerGuardrailPassed = false;

/**
 * Called from `index.ts` when the worker startup guardrail confirms the
 * event loop has ref'd handles. After this fires, every subsequent
 * heartbeat carries `guardrailPassed: true` so the admin panel can render
 * a green "self-check OK" badge.
 */
export function markWorkerGuardrailPassed(): void {
  workerGuardrailPassed = true;
}

async function writeWorkerHeartbeat(): Promise<void> {
  try {
    const beat: TranscoderHeartbeat = {
      pid: process.pid,
      ts: Date.now(),
      runMode: (process.env.RUN_MODE ?? "all").toLowerCase(),
      nodeVersion: process.version,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      uptimeSec: Math.round(process.uptime()),
      guardrailPassed: workerGuardrailPassed,
    };
    await cache.set(TRANSCODER_HEARTBEAT_KEY, beat, TRANSCODER_HEARTBEAT_TTL_MS);
  } catch (err) {
    logger.warn({ err }, "Failed to write transcoder heartbeat (non-fatal)");
  }
}

export function startRetryTick(intervalMs = 30_000): void {
  if (retryTickHandle) return;
  // Write an immediate heartbeat on startup so the Live Monitor reflects the
  // worker's existence even before the first 30 s tick fires.
  void writeWorkerHeartbeat();
  retryTickHandle = setInterval(() => {
    void writeWorkerHeartbeat();
    if (isWorkerRunning) return;
    db.select({ id: transcodingJobsTable.id })
      .from(transcodingJobsTable)
      .where(
        and(
          eq(transcodingJobsTable.status, "queued"),
          or(
            isNull(transcodingJobsTable.nextRetryAt),
            lte(transcodingJobsTable.nextRetryAt, new Date()),
          ),
        ),
      )
      .limit(1)
      .then((rows: Array<{ id: string }>) => {
        if (rows.length > 0) {
          startWorker().catch((err: unknown) =>
            logger.error({ err }, "Retry tick: worker crashed"),
          );
        }
      })
      .catch((err: unknown) =>
        logger.error({ err }, "Retry tick: query failed"),
      );
  }, intervalMs);
  retryTickHandle.unref();
  logger.info({ intervalMs }, "Transcoding retry tick started");
}

export function stopRetryTick(): void {
  if (retryTickHandle) {
    clearInterval(retryTickHandle);
    retryTickHandle = null;
  }
}

export async function queueTranscodingJob(
  videoId: string,
  videoPath: string,
  priority = 0
): Promise<string> {
  const jobId = randomUUID();

  await db.insert(transcodingJobsTable).values({
    id: jobId,
    videoId,
    videoPath,
    status: "queued",
    priority,
    progress: 0,
  });

  await db
    .update(videosTable)
    .set({ transcodingStatus: "queued" })
    .where(eq(videosTable.id, videoId));

  logger.info({ jobId, videoId, priority }, "Transcoding job queued");

  setImmediate(() => {
    startWorker().catch((err) => {
      logger.error({ err }, "Transcoding worker crashed");
    });
  });

  return jobId;
}

export async function retryTranscodingJob(jobId: string): Promise<void> {
  // Manual retry from admin UI — reset attempts so the user gets a fresh
  // retry budget (3 more attempts) instead of immediately re-failing.
  await db
    .update(transcodingJobsTable)
    .set({
      status: "queued",
      progress: 0,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      attempts: 0,
      nextRetryAt: null,
    })
    .where(and(eq(transcodingJobsTable.id, jobId), eq(transcodingJobsTable.status, "failed")));

  const rows = await db.select().from(transcodingJobsTable).where(eq(transcodingJobsTable.id, jobId));
  const job = rows[0];
  if (job) {
    await db.update(videosTable).set({ transcodingStatus: "queued" }).where(eq(videosTable.id, job.videoId));
  }

  setImmediate(() => {
    startWorker().catch((err) => {
      logger.error({ err }, "Transcoding worker crashed on retry");
    });
  });
}

// Sentinel embedded in errorMessage so we can count, without a schema change,
// how many times a single job has crashed the container during transcoding.
// Each crash-recovery on startup appends one marker; once the count reaches
// CRASH_LOOP_LIMIT we mark the job FAILED instead of re-queueing it. This
// breaks the OOM/poison-pill pattern where a single oversized or malformed
// source file kills the container on every restart, taking the entire API
// server down with it. Without this guard, decrementing `attempts` (below)
// keeps the retry budget at 0–1 forever, so the same job runs every reboot.
const CRASH_RECOVERY_MARKER = "[crash-recovery]";
const CRASH_LOOP_LIMIT = 1; // tolerate 1 crash-recovery, fail on the 2nd

export async function resumePendingJobsOnStartup(): Promise<void> {
  const stuck = await db
    .select()
    .from(transcodingJobsTable)
    .where(eq(transcodingJobsTable.status, "processing"));

  for (const job of stuck) {
    const prevMessage = job.errorMessage ?? "";
    const crashCount = (prevMessage.match(/\[crash-recovery\]/g) ?? []).length;

    if (crashCount >= CRASH_LOOP_LIMIT) {
      logger.error(
        { jobId: job.id, videoId: job.videoId, crashCount },
        "Crash-loop guard: job found 'processing' on consecutive container restarts — marking failed to keep API alive",
      );
      await db
        .update(transcodingJobsTable)
        .set({
          status: "failed",
          progress: 0,
          startedAt: null,
          nextRetryAt: null,
          errorMessage: `Crash-loop guard: job was found 'processing' on ${crashCount + 1} consecutive container restarts. The encoder likely exceeded container memory or hung indefinitely. Manually retry from the admin UI after investigating the source file or upgrading the container's memory limit.`,
        })
        .where(eq(transcodingJobsTable.id, job.id));
      await db
        .update(videosTable)
        .set({ transcodingStatus: "failed" })
        .where(eq(videosTable.id, job.videoId));
      continue;
    }

    logger.warn(
      { jobId: job.id, crashCount },
      "Resetting stuck processing job to queued",
    );
    // Decrement attempts so the crash-recovery replay doesn't burn through
    // the retry budget (the previous attempt never ran to completion). The
    // crash-loop guard above caps total recoveries so this can't loop forever.
    const restoredAttempts = Math.max(0, job.attempts - 1);
    // Cap errorMessage growth at 1KB so a perpetually-recovering row can't
    // bloat the column. Trimming from the LEFT preserves the most recent
    // markers, which is what the counter cares about.
    const nextMessage = `${prevMessage}${CRASH_RECOVERY_MARKER}`.slice(-1000);
    await db
      .update(transcodingJobsTable)
      .set({
        status: "queued",
        progress: 0,
        startedAt: null,
        attempts: restoredAttempts,
        nextRetryAt: null,
        errorMessage: nextMessage,
      })
      .where(eq(transcodingJobsTable.id, job.id));
    await db
      .update(videosTable)
      .set({ transcodingStatus: "queued" })
      .where(eq(videosTable.id, job.videoId));
  }

  const queued = await db
    .select()
    .from(transcodingJobsTable)
    .where(eq(transcodingJobsTable.status, "queued"))
    .limit(1);

  if (queued.length > 0) {
    logger.info("Resuming transcoding queue after startup");
    setImmediate(() => {
      startWorker().catch((err) => {
        logger.error({ err }, "Transcoding worker crashed on startup resume");
      });
    });
  }
}
