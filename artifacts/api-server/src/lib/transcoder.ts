import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { db, videosTable, transcodingJobsTable, broadcastQueueTable } from "@workspace/db";
import { eq, and, desc, asc } from "drizzle-orm";
import { logger } from "./logger";
import { broadcastLiveEvent } from "./liveEvents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const HLS_DIR = path.join(UPLOADS_DIR, "hls");

interface QualityProfile {
  name: string;
  height: number;
  videoBitrate: string;
  maxBitrate: string;
  bufsize: string;
  audioBitrate: string;
  bandwidth: number;
}

const QUALITY_PROFILES: QualityProfile[] = [
  {
    name: "1080p",
    height: 1080,
    videoBitrate: "4000k",
    maxBitrate: "4500k",
    bufsize: "9000k",
    audioBitrate: "128k",
    bandwidth: 4000000,
  },
  {
    name: "720p",
    height: 720,
    videoBitrate: "2500k",
    maxBitrate: "2800k",
    bufsize: "5600k",
    audioBitrate: "128k",
    bandwidth: 2500000,
  },
  {
    name: "480p",
    height: 480,
    videoBitrate: "1200k",
    maxBitrate: "1400k",
    bufsize: "2800k",
    audioBitrate: "96k",
    bandwidth: 1200000,
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

async function transcodeQuality(
  inputPath: string,
  outputDir: string,
  profile: QualityProfile,
  onProgress?: (pct: number) => void
): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });

  const segmentPattern = path.join(outputDir, "seg%04d.ts");
  const playlistPath = path.join(outputDir, "index.m3u8");

  const args = [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-vf", `scale=-2:${profile.height}`,
    "-c:v", "libx264",
    "-preset", "fast",
    "-b:v", profile.videoBitrate,
    "-maxrate", profile.maxBitrate,
    "-bufsize", profile.bufsize,
    "-c:a", "aac",
    "-b:a", profile.audioBitrate,
    "-ar", "48000",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", segmentPattern,
    "-hls_flags", "independent_segments",
    playlistPath,
  ];

  await runFFmpeg(args, onProgress);
}

async function generateMasterPlaylist(hlsVideoDir: string): Promise<void> {
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "",
  ];

  for (const profile of QUALITY_PROFILES) {
    const qualityDir = path.join(hlsVideoDir, profile.name);
    const playlistPath = path.join(qualityDir, "index.m3u8");

    try {
      await fs.access(playlistPath);

      const resolution =
        profile.name === "1080p" ? "1920x1080" :
        profile.name === "720p" ? "1280x720" :
        "854x480";

      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bandwidth},RESOLUTION=${resolution},CODECS="avc1.4d4028,mp4a.40.2",NAME="${profile.name}"`
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

    for (let i = 0; i < QUALITY_PROFILES.length; i++) {
      const profile = QUALITY_PROFILES[i];
      const qualityOutputDir = path.join(hlsVideoDir, profile.name);

      logger.info({ jobId: job.id, quality: profile.name }, "Transcoding quality variant");

      const profileBaseProgress = Math.round((i / QUALITY_PROFILES.length) * 100);
      const profileProgressRange = Math.round(100 / QUALITY_PROFILES.length);

      let lastBroadcastPct = -1;

      await transcodeQuality(job.videoPath, qualityOutputDir, profile, async (pct) => {
        const overall = profileBaseProgress + Math.round((pct / 100) * profileProgressRange);
        await db
          .update(transcodingJobsTable)
          .set({ progress: overall })
          .where(eq(transcodingJobsTable.id, job.id));

        if (overall - lastBroadcastPct >= 5) {
          lastBroadcastPct = overall;
          broadcastLiveEvent("transcoding-update", {
            jobId: job.id,
            videoId: job.videoId,
            status: "processing",
            progress: overall,
          });
        }
      });
    }

    await generateMasterPlaylist(hlsVideoDir);

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
      .set({ localVideoUrl: hlsMasterUrl, videoSource: "local" })
      .where(eq(broadcastQueueTable.videoId, job.videoId));

    logger.info({ jobId: job.id, videoId: job.videoId, hlsMasterUrl }, "Transcoding complete");

    broadcastLiveEvent("transcoding-update", {
      jobId: job.id,
      videoId: job.videoId,
      status: "done",
      progress: 100,
      hlsMasterUrl,
    });
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
