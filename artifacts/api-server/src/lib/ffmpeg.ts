import { spawn, spawnSync } from "child_process";
import { promises as fs } from "fs";
import { logger } from "./logger";

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
  ffmpegVersion: string;
}

export interface ProbedMedia {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  videoCodec: string | null;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

let cached: FfmpegBinaries | null = null;

/**
 * Thrown for input-classified failures (corrupt media, missing video stream,
 * unsupported container, zero duration, etc). The worker treats these as
 * terminal — no retries — because re-running the same encoder against the
 * same broken input will produce the same failure.
 */
export class TerminalTranscodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalTranscodeError";
  }
}

export function isFfmpegReady(): boolean {
  return cached !== null;
}

function resolveBinary(name: string): string | null {
  const fromEnv =
    name === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  if (fromEnv) {
    const probe = spawnSync(fromEnv, ["-version"], { stdio: "ignore" });
    if (probe.status === 0) return fromEnv;
    logger.warn(
      { name, fromEnv },
      "Configured binary path failed -version probe; falling back to PATH lookup",
    );
  }

  const which = spawnSync("which", [name], { encoding: "utf-8" });
  if (which.status === 0) {
    const found = which.stdout.trim();
    if (found) return found;
  }

  const probe = spawnSync(name, ["-version"], { stdio: "ignore" });
  if (probe.status === 0) return name;

  return null;
}

/**
 * Resolve ffmpeg + ffprobe binaries once at startup. Throws a clear,
 * actionable error if either binary is missing — preventing the worker
 * from spinning up jobs that would all fail with confusing spawn errors.
 */
export async function assertFfmpegAvailable(): Promise<FfmpegBinaries> {
  if (cached) return cached;

  const ffmpegPath = resolveBinary("ffmpeg");
  const ffprobePath = resolveBinary("ffprobe");

  if (!ffmpegPath || !ffprobePath) {
    const missing: string[] = [];
    if (!ffmpegPath) missing.push("ffmpeg");
    if (!ffprobePath) missing.push("ffprobe");
    throw new Error(
      `Required binary not found: ${missing.join(", ")}. ` +
        `Install ffmpeg in the runtime environment (e.g. nix package "ffmpeg-full", ` +
        `or "apt-get install ffmpeg" in container images), or set FFMPEG_PATH / FFPROBE_PATH.`,
    );
  }

  const versionProbe = spawnSync(ffmpegPath, ["-version"], { encoding: "utf-8" });
  const ffmpegVersion =
    versionProbe.stdout?.split("\n")[0]?.trim() ?? "ffmpeg (unknown version)";

  cached = { ffmpeg: ffmpegPath, ffprobe: ffprobePath, ffmpegVersion };
  logger.info(
    { ffmpeg: ffmpegPath, ffprobe: ffprobePath, ffmpegVersion },
    "FFmpeg binaries verified",
  );
  return cached;
}

export function getBinaries(): FfmpegBinaries {
  if (!cached) {
    throw new Error(
      "FFmpeg binaries not initialized. Call assertFfmpegAvailable() at boot.",
    );
  }
  return cached;
}

/**
 * Strict input validation. Returns probed metadata or throws with a
 * human-readable reason. Used to reject corrupt / unsupported uploads
 * before the encoder is initialized — eliminating "encoder creation
 * error" classes of failure that originate from bad input.
 */
export async function validateAndProbeInput(inputPath: string): Promise<ProbedMedia> {
  const { ffprobe } = getBinaries();

  // 1. File must exist and be non-empty.
  let size = 0;
  try {
    const stat = await fs.stat(inputPath);
    if (!stat.isFile()) throw new TerminalTranscodeError("Input is not a regular file");
    size = stat.size;
  } catch (err) {
    if (err instanceof TerminalTranscodeError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new TerminalTranscodeError(`Input file inaccessible: ${msg}`);
  }
  if (size < 1024) {
    throw new TerminalTranscodeError(
      `Input file too small to be valid media (${size} bytes)`,
    );
  }

  // 2. ffprobe the container + all streams.
  const result = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const proc = spawn(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,r_frame_rate,duration",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        inputPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
    proc.on("error", (err) =>
      resolve({ code: -1, stdout: "", stderr: err.message }),
    );
  });

  if (result.code !== 0) {
    throw new TerminalTranscodeError(
      `ffprobe failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500) || "no stderr"}`,
    );
  }

  let parsed: {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new TerminalTranscodeError(
      "ffprobe returned invalid JSON — input is not parseable media",
    );
  }

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  if (!videoStream) {
    throw new TerminalTranscodeError("Input contains no video stream");
  }

  const width = Number(videoStream.width ?? 0);
  const height = Number(videoStream.height ?? 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) {
    throw new TerminalTranscodeError(
      `Invalid video dimensions ${width}x${height} — input is malformed`,
    );
  }

  let fps = 30;
  if (videoStream.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      const computed = num / den;
      if (computed > 0 && computed < 240) fps = Math.round(computed);
    }
  }

  const formatDur = parseFloat(parsed.format?.duration ?? "");
  const streamDur = parseFloat(videoStream.duration ?? "");
  const durationSec = Number.isFinite(formatDur) && formatDur > 0
    ? formatDur
    : Number.isFinite(streamDur) && streamDur > 0
      ? streamDur
      : 0;

  if (durationSec <= 0) {
    throw new TerminalTranscodeError(
      "Could not determine input duration — file may be truncated",
    );
  }

  // 3. Codec compatibility — libx264 + aac transcoder accepts any decodable
  //    codec ffmpeg knows about; we only reject codecs explicitly disabled
  //    in the build. Most failures here surface as decode errors at runtime,
  //    so we whitelist the well-known supported families and warn on the rest.
  const videoCodec = videoStream.codec_name ?? null;
  const audioCodec = audioStream?.codec_name ?? null;

  const KNOWN_VIDEO = new Set([
    "h264", "hevc", "h265", "vp8", "vp9", "av1", "mpeg4", "mpeg2video",
    "mpeg1video", "theora", "vc1", "wmv1", "wmv2", "wmv3", "msmpeg4v1",
    "msmpeg4v2", "msmpeg4v3", "prores", "dnxhd", "huffyuv", "ffv1",
    "rawvideo", "flv1", "rv40", "rv30",
  ]);
  if (videoCodec && !KNOWN_VIDEO.has(videoCodec)) {
    logger.warn(
      { videoCodec, inputPath },
      "Unrecognized video codec — encoder will attempt anyway",
    );
  }

  return {
    width,
    height,
    fps,
    durationSec,
    videoCodec,
    audioCodec,
    hasVideo: true,
    hasAudio: !!audioStream,
  };
}

/**
 * Spawn ffmpeg with idle + wall-clock watchdogs.
 *
 * - `idleTimeoutMs`: kill process if no stderr output for this long
 *   (catches hung encoders that aren't crashing but aren't progressing).
 * - `maxWallClockMs`: absolute ceiling, kills regardless of progress
 *   (catches pathological inputs that progress one frame per minute).
 *
 * Both timers are cleared on close. Both kills use SIGTERM first, then
 * SIGKILL after a 5 s grace period.
 */
export interface FfmpegRunOptions {
  args: string[];
  onProgress?: (percent: number) => void;
  idleTimeoutMs?: number;
  maxWallClockMs?: number;
  signal?: AbortSignal;
}

function parseDurationToSeconds(dur: string): number {
  const match = dur.match(/(\d+):(\d+):(\d+\.?\d*)/);
  if (!match) return 0;
  return (
    parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3])
  );
}

export function runFfmpeg(opts: FfmpegRunOptions): Promise<void> {
  const { ffmpeg } = getBinaries();
  const idleTimeoutMs = opts.idleTimeoutMs ?? 90_000;
  const maxWallClockMs = opts.maxWallClockMs ?? 4 * 60 * 60 * 1000; // 4 h

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, opts.args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let totalDuration = 0;
    let stderr = "";
    let lastStderrAt = Date.now();
    let killedReason: string | null = null;

    const killGracefully = (reason: string) => {
      if (killedReason) return;
      killedReason = reason;
      logger.warn({ pid: proc.pid, reason }, "Killing ffmpeg process");
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 5_000).unref();
    };

    const wallClockTimer = setTimeout(
      () => killGracefully(`exceeded max wall clock ${maxWallClockMs}ms`),
      maxWallClockMs,
    );
    wallClockTimer.unref();

    const idleTimer = setInterval(() => {
      if (Date.now() - lastStderrAt > idleTimeoutMs) {
        killGracefully(`idle for ${idleTimeoutMs}ms (no stderr progress)`);
      }
    }, 10_000);
    idleTimer.unref();

    const onAbort = () => killGracefully("aborted by caller");
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stderr.on("data", (chunk: Buffer) => {
      lastStderrAt = Date.now();
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);

      if (totalDuration === 0) {
        const durMatch = text.match(/Duration:\s*(\d+:\d+:\d+\.?\d*)/);
        if (durMatch) totalDuration = parseDurationToSeconds(durMatch[1]);
      }
      if (opts.onProgress && totalDuration > 0) {
        const timeMatch = text.match(/time=(\d+:\d+:\d+\.?\d*)/);
        if (timeMatch) {
          const cur = parseDurationToSeconds(timeMatch[1]);
          const pct = Math.min(100, Math.round((cur / totalDuration) * 100));
          opts.onProgress(pct);
        }
      }
    });

    proc.on("close", (code, signal) => {
      clearTimeout(wallClockTimer);
      clearInterval(idleTimer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);

      if (killedReason) {
        const tail = stderr.split("\n").slice(-5).join("\n");
        return reject(
          new Error(
            `ffmpeg killed: ${killedReason}${tail ? ` — last stderr: ${tail}` : ""}`,
          ),
        );
      }
      if (code === 0) return resolve();

      const tail = stderr.split("\n").slice(-5).join("\n");
      reject(
        new Error(
          `ffmpeg exited code=${code} signal=${signal ?? "none"}: ${tail || "no stderr"}`,
        ),
      );
    });

    proc.on("error", (err) => {
      clearTimeout(wallClockTimer);
      clearInterval(idleTimer);
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}
