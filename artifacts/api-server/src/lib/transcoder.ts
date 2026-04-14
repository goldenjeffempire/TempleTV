import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { db, videosTable, transcodingJobsTable, broadcastQueueTable } from "@workspace/db";
import { eq, and, desc, asc } from "drizzle-orm";
import { logger } from "./logger";
import { broadcastLiveEvent } from "./liveEvents";
import { cache } from "./cache";
import { objectStorageClient } from "./objectStorage";
import { createReadStream } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const HLS_DIR = path.join(UPLOADS_DIR, "hls");
const BUCKET_ID = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";

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

// 5-level adaptive bitrate ladder — 240p to 1080p
// 2-second HLS segments ensure <3 s startup time
const QUALITY_PROFILES: QualityProfile[] = [
  {
    name: "1080p",
    height: 1080,
    videoBitrate: "4000k",
    maxBitrate: "4500k",
    bufsize: "9000k",
    audioBitrate: "128k",
    bandwidth: 4000000,
    resolution: "1920x1080",
  },
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

function parseDurationToSeconds(dur: string): number {
  const match = dur.match(/(\d+):(\d+):(\d+\.?\d*)/);
  if (!match) return 0;
  return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
}

function runFFmpeg(
  args: string[],
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

    let totalDuration = 0;
    let stderr = "";

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;

      if (totalDuration === 0) {
        const durMatch = text.match(/Duration:\s*(\d+:\d+:\d+\.?\d*)/);
        if (durMatch) {
          totalDuration = parseDurationToSeconds(durMatch[1]);
        }
      }

      if (onProgress && totalDuration > 0) {
        const timeMatch = text.match(/time=(\d+:\d+:\d+\.?\d*)/);
        if (timeMatch) {
          const currentTime = parseDurationToSeconds(timeMatch[1]);
          const pct = Math.min(100, Math.round((currentTime / totalDuration) * 100));
          onProgress(pct);
        }
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const lastLines = stderr.split("\n").slice(-5).join("\n");
        reject(new Error(`FFmpeg exited with code ${code}: ${lastLines}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
    });
  });
}

async function probeDuration(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ], { stdio: ["ignore", "pipe", "ignore"] });

    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", () => {
      const val = parseFloat(output.trim());
      resolve(Number.isFinite(val) && val > 0 ? Math.round(val) : 0);
    });
    proc.on("error", () => resolve(0));
  });
}

async function probeVideoInfo(inputPath: string): Promise<{ width: number; height: number; fps: number }> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate",
      "-of", "json",
      inputPath,
    ], { stdio: ["ignore", "pipe", "ignore"] });

    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", () => {
      try {
        const parsed = JSON.parse(output) as { streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }> };
        const stream = parsed.streams?.[0];
        const width = stream?.width ?? 0;
        const height = stream?.height ?? 0;
        let fps = 30;
        if (stream?.r_frame_rate) {
          const [num, den] = stream.r_frame_rate.split("/").map(Number);
          if (num && den && den > 0) fps = Math.round(num / den);
        }
        resolve({ width, height, fps });
      } catch {
        resolve({ width: 0, height: 0, fps: 30 });
      }
    });
    proc.on("error", () => resolve({ width: 0, height: 0, fps: 30 }));
  });
}

async function transcodeQuality(
  inputPath: string,
  outputDir: string,
  profile: QualityProfile,
  sourceHeight: number,
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

  const args = [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",    // optional audio (won't fail if no audio)
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

  await runFFmpeg(args, onProgress);
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
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bandwidth},RESOLUTION=${profile.resolution},CODECS="avc1.4d401f,mp4a.40.2",NAME="${profile.name}"`
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

// ── GCS upload (best-effort, non-blocking for serving) ────────────────────────
async function uploadHlsToGcs(videoId: string, localHlsDir: string): Promise<void> {
  if (!BUCKET_ID) return;

  try {
    const bucket = objectStorageClient.bucket(BUCKET_ID);
    const allFiles = await collectFiles(localHlsDir);

    await Promise.all(
      allFiles.map(async (localPath) => {
        const relative = path.relative(localHlsDir, localPath);
        const objectName = `hls/${videoId}/${relative}`;
        const contentType = localPath.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/mp2t";

        await bucket.file(objectName).save(createReadStream(localPath), {
          metadata: { contentType },
          resumable: false,
        });
      })
    );

    logger.info({ videoId, fileCount: allFiles.length }, "HLS output uploaded to GCS");
  } catch (err) {
    logger.warn({ videoId, err }, "GCS HLS upload failed (local serving still active)");
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

async function processNextJob(): Promise<boolean> {
  const rows = await db
    .select()
    .from(transcodingJobsTable)
    .where(eq(transcodingJobsTable.status, "queued"))
    .orderBy(desc(transcodingJobsTable.priority), asc(transcodingJobsTable.createdAt))
    .limit(1);

  const job = rows[0];
  if (!job) return false;

  logger.info({ jobId: job.id, videoId: job.videoId }, "Starting transcoding job");

  await db
    .update(transcodingJobsTable)
    .set({ status: "processing", startedAt: new Date(), progress: 0 })
    .where(eq(transcodingJobsTable.id, job.id));

  await db
    .update(videosTable)
    .set({ transcodingStatus: "processing" })
    .where(eq(videosTable.id, job.videoId));

  broadcastLiveEvent("transcoding-update", {
    jobId: job.id,
    videoId: job.videoId,
    status: "processing",
    progress: 0,
  });

  try {
    const hlsVideoDir = path.join(HLS_DIR, job.videoId);
    await fs.mkdir(hlsVideoDir, { recursive: true });

    // Probe source video to skip upscale variants
    const { height: sourceHeight } = await probeVideoInfo(job.videoPath);

    const producedProfiles: QualityProfile[] = [];

    for (let i = 0; i < QUALITY_PROFILES.length; i++) {
      const profile = QUALITY_PROFILES[i]!;
      const qualityOutputDir = path.join(hlsVideoDir, profile.name);

      logger.info({ jobId: job.id, quality: profile.name }, "Transcoding quality variant");

      const profileBaseProgress = Math.round((i / QUALITY_PROFILES.length) * 100);
      const profileProgressRange = Math.round(100 / QUALITY_PROFILES.length);

      let lastBroadcastPct = -1;

      const produced = await transcodeQuality(
        job.videoPath,
        qualityOutputDir,
        profile,
        sourceHeight,
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
        }
      );

      if (produced) producedProfiles.push(profile);
    }

    await generateMasterPlaylist(hlsVideoDir, producedProfiles);

    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    const baseUrl = process.env.API_BASE_URL ?? (devDomain ? `https://${devDomain}` : "");
    const hlsMasterUrl = `${baseUrl}/api/hls/${job.videoId}/master.m3u8`;

    const probedDuration = await probeDuration(job.videoPath);

    await db
      .update(transcodingJobsTable)
      .set({ status: "done", progress: 100, completedAt: new Date() })
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

    await cache.del("broadcast:queue");

    logger.info({ jobId: job.id, videoId: job.videoId, hlsMasterUrl }, "Transcoding complete");

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

    // Upload HLS output to GCS for CDN-backed durability (non-blocking)
    uploadHlsToGcs(job.videoId, hlsVideoDir).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId: job.id, err: msg }, "Transcoding job failed");

    await db
      .update(transcodingJobsTable)
      .set({ status: "failed", errorMessage: msg })
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
  await db
    .update(transcodingJobsTable)
    .set({ status: "queued", progress: 0, errorMessage: null, startedAt: null, completedAt: null })
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

export async function resumePendingJobsOnStartup(): Promise<void> {
  const stuck = await db
    .select()
    .from(transcodingJobsTable)
    .where(eq(transcodingJobsTable.status, "processing"));

  for (const job of stuck) {
    logger.warn({ jobId: job.id }, "Resetting stuck processing job to queued");
    await db
      .update(transcodingJobsTable)
      .set({ status: "queued", progress: 0, startedAt: null })
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
