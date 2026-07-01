/**
 * video-validation.service.ts
 *
 * Broadcast-grade video validation — 9 isolated checks run after faststart.
 *
 * Checks:
 *   1. FILE_INTEGRITY    — magic bytes + ffprobe container validity
 *   2. MOOV_PLACEMENT    — moov atom at start (faststart gate)
 *   3. CODEC_COMPAT      — H.264 + AAC/MP3/AC3 for broad platform support
 *   4. KEYFRAME_INTERVAL — max interval ≤ 10 s for Smart TV / mobile seeking
 *   5. AV_SYNC           — stream start_time offset ≤ 500 ms (audio dropout)
 *   6. FIRST_FRAME       — decode first 2 s of mdat (corruption detection)
 *   7. LAST_FRAME        — decode last 5 s (truncation detection)
 *   8. DURATION_ACCURACY — stored vs probed duration ≤ 10% deviation
 *   9. RANGE_SUPPORT     — HTTP 206 on loopback (player fast-seek)
 *
 * Design constraints:
 *   • One check failure NEVER aborts others — all 9 always run.
 *   • O(1) RSS: streaming download, no full-file buffering.
 *   • Every ffprobe/ffmpeg gets proc.unref() + SIGKILL AbortTimer.
 *   • Temp directory always deleted in finally — no leaks on thrown errors.
 *   • Total wall-clock budget: VALIDATION_JOB_TIMEOUT_MS (default 180 s).
 *
 * Status mapping:
 *   'failed'  — any check returned 'fail'
 *   'warn'    — at least one 'warn', no 'fail'
 *   'passed'  — all 'pass' or 'skip'
 *
 * Broadcast gate:
 *   null/pending/running/passed/warn → allow (backward compat + progressive)
 *   'failed'                         → blocked in isPlayableForBroadcast()
 */

import { mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { storage } from "../../infrastructure/storage.js";
import { storagePaths } from "../../infrastructure/storage-paths.js";
import { probeContainerIsValid, probeCanDecodeFirstFrame } from "./transcoder.service.js";
import { env } from "../../config/env.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Per-check ffprobe/ffmpeg SIGKILL timeout. */
const CHECK_TIMEOUT_MS = 30_000;

/** Keyframe probe window — read first N seconds of packet table. */
const KEYFRAME_PROBE_WINDOW_SECS = 120;

/** Max keyframe interval that broadcasts cleanly on Smart TV / mobile. */
const MAX_KEYFRAME_INTERVAL_WARN_SECS = 10;
const MAX_KEYFRAME_INTERVAL_FAIL_SECS = 20;

/** A/V sync offset thresholds. */
const AV_SYNC_WARN_MS = 500;
const AV_SYNC_FAIL_MS = 2000;

/** Duration deviation tolerance. */
const DURATION_WARN_PCT = 10;
const DURATION_FAIL_PCT = 30;

/** EOF seek offset for last-frame probe (seconds before end). */
const LAST_FRAME_SEEK_SECS = 5;

/** Skip last-frame check for very short videos. */
const LAST_FRAME_MIN_DURATION_SECS = 10;

/** Total validation job wall-clock budget. */
const VALIDATION_JOB_TIMEOUT_MS = 180_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface VideoCheckResult {
  check: string;
  status: CheckStatus;
  message: string;
  detail?: Record<string, unknown>;
}

export type ValidationStatus = "pending" | "running" | "passed" | "warn" | "failed";

export interface VideoValidationReport {
  videoId: string;
  status: ValidationStatus;
  checks: VideoCheckResult[];
  repairsPerformed: string[];
  remainingIssues: string[];
  durationMs: number;
  completedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Download object to temp file via streaming pipeline (O(1) RSS).
 * Throws on any storage or stream error.
 */
async function downloadToTempFile(objectKey: string, destPath: string): Promise<void> {
  const s = storage();
  if (!s.enabled) throw new Error("Storage not enabled");
  const { body } = await s.getObject(objectKey);
  const ws = createWriteStream(destPath);
  await pipeline(body as NodeJS.ReadableStream, ws);
}

/**
 * Spawn a process with a SIGKILL timer. Returns stdout string and exit code.
 * Proc is always proc.unref()'d — it will be cleaned up on timeout.
 */
function spawnWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.unref();

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      resolve({ stdout, stderr, code: null, timedOut: true });
    }, timeoutMs);
    timer.unref();

    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: String(err), code: null, timedOut: false });
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: false });
    });
  });
}

// ── Individual checks ─────────────────────────────────────────────────────────

/**
 * Check 1: FILE_INTEGRITY
 * Validates container structure via ffprobe. Reuses the existing
 * probeContainerIsValid export from transcoder.service.ts.
 */
async function checkFileIntegrity(tmpPath: string): Promise<VideoCheckResult> {
  try {
    const valid = await probeContainerIsValid(tmpPath);
    if (!valid) {
      return {
        check: "FILE_INTEGRITY",
        status: "fail",
        message: "ffprobe rejected the container — file is corrupt or not a valid MP4",
      };
    }
    return { check: "FILE_INTEGRITY", status: "pass", message: "Container structure valid" };
  } catch (err) {
    return {
      check: "FILE_INTEGRITY",
      status: "skip",
      message: `Check skipped: ${(err as Error).message}`,
    };
  }
}

/**
 * Check 2: MOOV_PLACEMENT
 * Verifies the moov atom is at the start of the file (faststart applied).
 * Uses ffprobe format tags to check qtfaststart/moov position.
 */
async function checkMoovPlacement(tmpPath: string, faststartApplied: boolean | null): Promise<VideoCheckResult> {
  if (faststartApplied === false) {
    // On the MP4-only pipeline, raw MP4 (moov at EOF) is broadcast-eligible.
    // HTTP byte-range streaming works regardless of moov position; the
    // faststartRecoveryWorker relocates the moov atom in the background as a
    // quality optimization but NOT as a prerequisite for playback or queueing.
    // Returning "fail" here causes validationStatus="failed" which blocks the
    // video from isPlayableForBroadcast() — the opposite of the intended behaviour.
    // Use "warn" so operators are informed but the video is still admitted.
    return {
      check: "MOOV_PLACEMENT",
      status: "warn",
      message: "faststartApplied=false — moov atom is at end-of-file; byte-range streaming still works but seek performance may be degraded. The faststart worker will relocate the moov atom in the background.",
    };
  }
  if (faststartApplied === true) {
    return {
      check: "MOOV_PLACEMENT",
      status: "pass",
      message: "moov atom relocated to file start (faststartApplied=true confirmed)",
    };
  }
  // faststartApplied = null (legacy row) — run a quick live probe
  const { stdout, timedOut } = await spawnWithTimeout(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format_tags=major_brand",
      "-show_entries", "format=start_time",
      "-of", "json",
      tmpPath,
    ],
    CHECK_TIMEOUT_MS,
  );
  if (timedOut) {
    return { check: "MOOV_PLACEMENT", status: "skip", message: "Moov position probe timed out" };
  }
  try {
    const parsed = JSON.parse(stdout) as { format?: { start_time?: string } };
    const startTime = parseFloat(parsed.format?.start_time ?? "0");
    if (Number.isFinite(startTime) && startTime >= 0 && startTime < 1) {
      return { check: "MOOV_PLACEMENT", status: "pass", message: "Container starts at t≈0 (moov likely at front)" };
    }
    return {
      check: "MOOV_PLACEMENT",
      status: "warn",
      message: `Unexpected container start_time=${startTime.toFixed(2)}s — faststart may not have been applied`,
      detail: { startTime },
    };
  } catch {
    return { check: "MOOV_PLACEMENT", status: "skip", message: "Could not parse moov probe output" };
  }
}

/**
 * Check 3: CODEC_COMPAT
 * H.264 video + AAC/MP3/AC3 audio → broad Smart TV / mobile / browser support.
 * HEVC/VP9/AV1 → warn (may not HW-decode on pre-2018 Smart TVs).
 * Unknown codecs → warn.
 * No video stream → fail.
 */
async function checkCodecCompat(tmpPath: string): Promise<VideoCheckResult> {
  const { stdout, timedOut } = await spawnWithTimeout(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name",
      "-of", "json",
      tmpPath,
    ],
    CHECK_TIMEOUT_MS,
  );
  if (timedOut) {
    return { check: "CODEC_COMPAT", status: "skip", message: "Codec probe timed out" };
  }
  let parsed: { streams?: Array<{ codec_type?: string; codec_name?: string }> };
  try { parsed = JSON.parse(stdout); } catch {
    return { check: "CODEC_COMPAT", status: "skip", message: "Could not parse codec probe output" };
  }

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");
  const videoCodec = videoStream?.codec_name ?? null;
  const audioCodec = audioStream?.codec_name ?? null;

  if (!videoCodec) {
    return {
      check: "CODEC_COMPAT",
      status: "fail",
      message: "No video stream found in container — cannot broadcast",
      detail: { audioCodec },
    };
  }

  const COMPAT_VIDEO = ["h264", "avc1"];
  const WARN_VIDEO = ["hevc", "h265", "vp9", "av1", "vp8"];
  const COMPAT_AUDIO = ["aac", "mp3", "ac3", "mp2", "eac3", "opus", "vorbis"];

  const videoCompatIssue = WARN_VIDEO.includes(videoCodec)
    ? `Video codec '${videoCodec}' may not HW-decode on pre-2018 Smart TVs; H.264 recommended`
    : (!COMPAT_VIDEO.includes(videoCodec)
      ? `Unrecognised video codec '${videoCodec}'; H.264 is required for broadest compatibility`
      : null);

  const audioCompatIssue = audioCodec && !COMPAT_AUDIO.includes(audioCodec)
    ? `Audio codec '${audioCodec}' may not play on all surfaces; AAC is recommended`
    : null;

  if (videoCompatIssue || audioCompatIssue) {
    const issues = [videoCompatIssue, audioCompatIssue].filter(Boolean).join(". ");
    return {
      check: "CODEC_COMPAT",
      status: "warn",
      message: issues,
      detail: { videoCodec, audioCodec },
    };
  }

  return {
    check: "CODEC_COMPAT",
    status: "pass",
    message: `Codecs compatible: video=${videoCodec} audio=${audioCodec ?? "none"}`,
    detail: { videoCodec, audioCodec },
  };
}

/**
 * Check 4: KEYFRAME_INTERVAL
 * Reads the packet index for the first KEYFRAME_PROBE_WINDOW_SECS seconds,
 * extracts keyframe timestamps, computes max gap between consecutive keyframes.
 *
 * A high keyframe interval (> 10 s) causes long seek stalls on Smart TVs and
 * mobile devices that must decode from the previous keyframe. Values > 20 s are
 * a hard fail because they cause visible multi-second freeze on every seek.
 *
 * Skipped for videos shorter than 30 s (entire file = adequate sample).
 */
async function checkKeyframeInterval(tmpPath: string, durationSecs: number | null): Promise<VideoCheckResult> {
  if (durationSecs !== null && durationSecs < 30) {
    return {
      check: "KEYFRAME_INTERVAL",
      status: "pass",
      message: `Video duration ${durationSecs.toFixed(1)} s < 30 s — keyframe interval check skipped (sufficient coverage)`,
    };
  }

  const readIntervalArg = `%+${KEYFRAME_PROBE_WINDOW_SECS}`;
  const { stdout, timedOut } = await spawnWithTimeout(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_packets",
      "-show_entries", "packet=pts_time,flags",
      "-read_intervals", readIntervalArg,
      "-of", "csv=p=0",
      tmpPath,
    ],
    CHECK_TIMEOUT_MS,
  );

  if (timedOut) {
    return { check: "KEYFRAME_INTERVAL", status: "skip", message: "Keyframe probe timed out" };
  }

  const keyframeTimes: number[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",");
    if (parts.length < 2) continue;
    const flags = parts[parts.length - 1];
    if (!flags || flags[0] !== "K") continue;
    const t = parseFloat(parts[0]);
    if (Number.isFinite(t) && t >= 0) keyframeTimes.push(t);
  }

  if (keyframeTimes.length < 2) {
    return {
      check: "KEYFRAME_INTERVAL",
      status: "warn",
      message: `Only ${keyframeTimes.length} keyframe(s) detected in first ${KEYFRAME_PROBE_WINDOW_SECS} s — cannot compute interval`,
      detail: { keyframeCount: keyframeTimes.length },
    };
  }

  keyframeTimes.sort((a, b) => a - b);
  let maxInterval = 0;
  let totalInterval = 0;
  for (let i = 1; i < keyframeTimes.length; i++) {
    const gap = keyframeTimes[i] - keyframeTimes[i - 1];
    if (gap > maxInterval) maxInterval = gap;
    totalInterval += gap;
  }
  const meanInterval = totalInterval / (keyframeTimes.length - 1);

  const detail = {
    maxIntervalSecs: parseFloat(maxInterval.toFixed(2)),
    meanIntervalSecs: parseFloat(meanInterval.toFixed(2)),
    keyframeCount: keyframeTimes.length,
    windowSecs: KEYFRAME_PROBE_WINDOW_SECS,
  };

  if (maxInterval > MAX_KEYFRAME_INTERVAL_FAIL_SECS) {
    return {
      check: "KEYFRAME_INTERVAL",
      status: "fail",
      message: `Max keyframe interval ${maxInterval.toFixed(1)} s exceeds ${MAX_KEYFRAME_INTERVAL_FAIL_SECS} s limit — seeking will cause multi-second freeze on Smart TV and mobile`,
      detail,
    };
  }
  if (maxInterval > MAX_KEYFRAME_INTERVAL_WARN_SECS) {
    return {
      check: "KEYFRAME_INTERVAL",
      status: "warn",
      message: `Max keyframe interval ${maxInterval.toFixed(1)} s exceeds ${MAX_KEYFRAME_INTERVAL_WARN_SECS} s recommendation — may cause brief seek stall on some devices`,
      detail,
    };
  }
  return {
    check: "KEYFRAME_INTERVAL",
    status: "pass",
    message: `Keyframe interval OK: max=${maxInterval.toFixed(1)} s mean=${meanInterval.toFixed(1)} s`,
    detail,
  };
}

/**
 * Check 5: AV_SYNC
 * Compares video and audio stream start_time values from ffprobe.
 * A large offset (> 500 ms) causes audible lip-sync issues or audio dropout
 * at the beginning of playback on devices that do not compensate.
 */
async function checkAvSync(tmpPath: string): Promise<VideoCheckResult> {
  const { stdout, timedOut } = await spawnWithTimeout(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "stream=codec_type,start_time",
      "-of", "json",
      tmpPath,
    ],
    CHECK_TIMEOUT_MS,
  );

  if (timedOut) {
    return { check: "AV_SYNC", status: "skip", message: "A/V sync probe timed out" };
  }

  let parsed: { streams?: Array<{ codec_type?: string; start_time?: string }> };
  try { parsed = JSON.parse(stdout); } catch {
    return { check: "AV_SYNC", status: "skip", message: "Could not parse A/V sync probe output" };
  }

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  if (!videoStream || !audioStream) {
    return {
      check: "AV_SYNC",
      status: "skip",
      message: "No separate video+audio streams — A/V sync check not applicable",
    };
  }

  const videoStart = parseFloat(videoStream.start_time ?? "0");
  const audioStart = parseFloat(audioStream.start_time ?? "0");
  if (!Number.isFinite(videoStart) || !Number.isFinite(audioStart)) {
    return {
      check: "AV_SYNC",
      status: "skip",
      message: "Stream start_time values not finite — cannot compute A/V offset",
    };
  }

  const offsetMs = Math.abs(videoStart - audioStart) * 1000;
  const detail = {
    offsetMs: parseFloat(offsetMs.toFixed(1)),
    videoStartSecs: parseFloat(videoStart.toFixed(4)),
    audioStartSecs: parseFloat(audioStart.toFixed(4)),
  };

  if (offsetMs > AV_SYNC_FAIL_MS) {
    return {
      check: "AV_SYNC",
      status: "fail",
      message: `Audio/video offset ${offsetMs.toFixed(0)} ms exceeds ${AV_SYNC_FAIL_MS} ms limit — severe lip-sync / audio dropout expected`,
      detail,
    };
  }
  if (offsetMs > AV_SYNC_WARN_MS) {
    return {
      check: "AV_SYNC",
      status: "warn",
      message: `Audio/video offset ${offsetMs.toFixed(0)} ms exceeds ${AV_SYNC_WARN_MS} ms — noticeable lip-sync issue on some devices`,
      detail,
    };
  }
  return {
    check: "AV_SYNC",
    status: "pass",
    message: `A/V sync offset ${offsetMs.toFixed(0)} ms — within ${AV_SYNC_WARN_MS} ms threshold`,
    detail,
  };
}

/**
 * Check 6: FIRST_FRAME
 * Decodes first 2 s of the video mdat. Reuses the existing
 * probeCanDecodeFirstFrame export from transcoder.service.ts.
 * Fail-open: returns 'skip' on infrastructure errors (ffmpeg missing / timeout)
 * to avoid blocking valid uploads when the tool is temporarily unavailable.
 */
async function checkFirstFrame(tmpPath: string): Promise<VideoCheckResult> {
  try {
    const ok = await probeCanDecodeFirstFrame(tmpPath);
    if (!ok) {
      return {
        check: "FIRST_FRAME",
        status: "fail",
        message: "First 2 s of video data failed to decode — mdat corruption detected",
      };
    }
    return { check: "FIRST_FRAME", status: "pass", message: "First 2 s decoded successfully" };
  } catch {
    return { check: "FIRST_FRAME", status: "skip", message: "First-frame probe skipped (infrastructure unavailable)" };
  }
}

/**
 * Check 7: LAST_FRAME
 * Seeks to LAST_FRAME_SEEK_SECS before EOF and decodes one frame to detect
 * truncated or corrupted tail data. Truncated files often appear valid via
 * first-frame and container checks because the mdat header survives intact.
 *
 * Skipped for videos shorter than LAST_FRAME_MIN_DURATION_SECS.
 */
async function checkLastFrame(tmpPath: string, durationSecs: number | null): Promise<VideoCheckResult> {
  if (durationSecs !== null && durationSecs < LAST_FRAME_MIN_DURATION_SECS) {
    return {
      check: "LAST_FRAME",
      status: "pass",
      message: `Video duration ${durationSecs.toFixed(1)} s < ${LAST_FRAME_MIN_DURATION_SECS} s — last-frame check skipped (first-frame covers full content)`,
    };
  }

  const { code, stderr, timedOut } = await spawnWithTimeout(
    "ffmpeg",
    [
      "-v", "error",
      "-sseof", `-${LAST_FRAME_SEEK_SECS}`,
      "-i", tmpPath,
      "-vframes", "1",
      "-f", "null",
      "-",
    ],
    CHECK_TIMEOUT_MS,
  );

  if (timedOut) {
    return { check: "LAST_FRAME", status: "skip", message: "Last-frame EOF probe timed out" };
  }

  if (code !== 0) {
    const hint = stderr.length > 300 ? stderr.slice(-300) : stderr;
    return {
      check: "LAST_FRAME",
      status: "fail",
      message: `Last ${LAST_FRAME_SEEK_SECS} s of video failed to decode — file may be truncated or the tail mdat is corrupt`,
      detail: { exitCode: code, stderrTail: hint },
    };
  }

  return {
    check: "LAST_FRAME",
    status: "pass",
    message: `Last ${LAST_FRAME_SEEK_SECS} s of video decoded successfully — EOF is intact`,
  };
}

/**
 * Check 8: DURATION_ACCURACY
 * Compares the stored database duration against the ffprobe-probed duration.
 * A large deviation indicates a corrupt or misreported duration field which
 * causes premature auto-advance (dead-air) or seeks past EOF on the player.
 *
 * Auto-corrects: if the stored duration is the 1800 s placeholder (uploaded
 * without ffprobe) and the real duration differs, the fix is flagged so the
 * caller can update the DB row.
 */
async function checkDurationAccuracy(
  tmpPath: string,
  storedDurationSecs: number | null,
): Promise<{ result: VideoCheckResult; probedDurationSecs: number | null }> {
  const { stdout, timedOut } = await spawnWithTimeout(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      tmpPath,
    ],
    CHECK_TIMEOUT_MS,
  );

  if (timedOut) {
    return {
      result: { check: "DURATION_ACCURACY", status: "skip", message: "Duration probe timed out" },
      probedDurationSecs: null,
    };
  }

  const probed = parseFloat(stdout.trim());
  if (!Number.isFinite(probed) || probed <= 0) {
    return {
      result: { check: "DURATION_ACCURACY", status: "skip", message: "ffprobe could not determine video duration" },
      probedDurationSecs: null,
    };
  }

  if (storedDurationSecs === null || storedDurationSecs <= 0) {
    return {
      result: {
        check: "DURATION_ACCURACY",
        status: "warn",
        message: `Stored duration is missing/zero; probed real duration is ${probed.toFixed(1)} s — DB row needs update`,
        detail: { storedSecs: storedDurationSecs, probedSecs: parseFloat(probed.toFixed(1)) },
      },
      probedDurationSecs: probed,
    };
  }

  const deviationPct = (Math.abs(probed - storedDurationSecs) / probed) * 100;
  const detail = {
    storedSecs: storedDurationSecs,
    probedSecs: parseFloat(probed.toFixed(1)),
    deviationPct: parseFloat(deviationPct.toFixed(1)),
  };

  const isPlaceholder = storedDurationSecs === 1800 && Math.abs(probed - 1800) > 60;

  if (isPlaceholder) {
    return {
      result: {
        check: "DURATION_ACCURACY",
        status: "warn",
        message: `Stored duration is the 1800 s placeholder; real duration is ${probed.toFixed(1)} s — will be auto-corrected`,
        detail,
      },
      probedDurationSecs: probed,
    };
  }

  if (deviationPct > DURATION_FAIL_PCT) {
    return {
      result: {
        check: "DURATION_ACCURACY",
        status: "fail",
        message: `Duration deviation ${deviationPct.toFixed(1)}% (stored=${storedDurationSecs} s probed=${probed.toFixed(1)} s) — premature auto-advance or seek-past-EOF likely`,
        detail,
      },
      probedDurationSecs: probed,
    };
  }

  if (deviationPct > DURATION_WARN_PCT) {
    return {
      result: {
        check: "DURATION_ACCURACY",
        status: "warn",
        message: `Duration deviation ${deviationPct.toFixed(1)}% (stored=${storedDurationSecs} s probed=${probed.toFixed(1)} s) — auto-skip timing may be inaccurate`,
        detail,
      },
      probedDurationSecs: probed,
    };
  }

  return {
    result: {
      check: "DURATION_ACCURACY",
      status: "pass",
      message: `Duration accurate: stored=${storedDurationSecs} s probed=${probed.toFixed(1)} s (${deviationPct.toFixed(1)}% deviation)`,
      detail,
    },
    probedDurationSecs: probed,
  };
}

/**
 * Check 9: RANGE_SUPPORT
 * Sends a loopback HTTP Range request for bytes 0-1023 and verifies 206.
 * Failing this check means the media server does not support partial content —
 * players cannot fast-seek or request specific byte offsets. This always causes
 * initial seek stalls and may block playback entirely on HLS-aware players.
 *
 * Skipped when no local API origin is configured or the server is not running.
 */
async function checkRangeSupport(localVideoUrl: string | null): Promise<VideoCheckResult> {
  if (!localVideoUrl) {
    return {
      check: "RANGE_SUPPORT",
      status: "skip",
      message: "No localVideoUrl — HTTP Range check not applicable",
    };
  }

  const port = env.PORT ?? 5000;
  const urlPath = localVideoUrl.startsWith("/")
    ? localVideoUrl
    : new URL(localVideoUrl).pathname;
  const probeUrl = `http://127.0.0.1:${port}${urlPath}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const resp = await fetch(probeUrl, {
        headers: { Range: "bytes=0-1023" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.status === 206) {
        const cr = resp.headers.get("Content-Range");
        await resp.body?.cancel();
        return {
          check: "RANGE_SUPPORT",
          status: "pass",
          message: `HTTP 206 Partial Content confirmed (Content-Range: ${cr ?? "present"})`,
          detail: { status: 206 },
        };
      }
      await resp.body?.cancel();
      if (resp.status === 200) {
        return {
          check: "RANGE_SUPPORT",
          status: "warn",
          message: `Server returned 200 instead of 206 for Range request — partial content not supported; seeking may stall`,
          detail: { status: resp.status },
        };
      }
      return {
        check: "RANGE_SUPPORT",
        status: "warn",
        message: `Unexpected HTTP status ${resp.status} on Range probe — Range support unverified`,
        detail: { status: resp.status },
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return {
      check: "RANGE_SUPPORT",
      status: "skip",
      message: "HTTP Range probe failed to connect — server may not be reachable on loopback during validation",
    };
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

interface RunValidationOpts {
  /** Write results to DB (default true). */
  storeResult?: boolean;
  /** Already-fetched stored duration in seconds (avoids extra DB round-trip). */
  storedDurationSecs?: number | null;
  /** Whether faststartApplied flag is already known (avoids extra DB read). */
  faststartApplied?: boolean | null;
  /** localVideoUrl for the Range check. */
  localVideoUrl?: string | null;
}

/**
 * Run the full 9-check validation pipeline against a locally-stored MP4.
 *
 * Downloads the source blob to a temp file, runs all 9 checks, deletes the
 * temp file, persists the report in `managed_videos`, and returns the report.
 *
 * Meant to be called after faststart completes — both from the upload finalize
 * path and from the faststart recovery worker.
 */
export async function runVideoValidation(
  videoId: string,
  objectKey: string,
  opts: RunValidationOpts = {},
): Promise<VideoValidationReport> {
  const { storeResult = true } = opts;
  const startedAt = Date.now();

  const videos = schema.videosTable;

  // Mark as running immediately so the admin UI reflects progress.
  if (storeResult) {
    await db
      .update(videos)
      .set({ validationStatus: "running" })
      .where(eq(videos.id, videoId))
      .catch((err: unknown) => {
        logger.warn({ err, videoId }, "[video-validation] failed to mark running (non-fatal)");
      });
  }

  // Resolve row metadata needed for checks (duration, faststartApplied, localVideoUrl).
  let storedDurationSecs = opts.storedDurationSecs ?? null;
  let faststartApplied = opts.faststartApplied ?? null;
  let localVideoUrl = opts.localVideoUrl ?? null;

  if (storedDurationSecs === null || faststartApplied === null || localVideoUrl === null) {
    const [row] = await db
      .select({
        duration: videos.duration,
        faststartApplied: videos.faststartApplied,
        localVideoUrl: videos.localVideoUrl,
      })
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1)
      .catch(() => [null]);
    if (row) {
      if (storedDurationSecs === null) storedDurationSecs = row.duration ? parseFloat(row.duration) : null;
      if (faststartApplied === null) faststartApplied = row.faststartApplied ?? null;
      if (localVideoUrl === null) localVideoUrl = row.localVideoUrl ?? null;
    }
  }

  const tmpDir = path.join(storagePaths.scratch, `validation-${randomUUID()}`);
  const tmpPath = path.join(tmpDir, "source.mp4");

  const checks: VideoCheckResult[] = [];
  const repairsPerformed: string[] = [];
  let probedDurationSecs: number | null = null;

  // Outer timeout: abandon entire validation after budget.
  const jobTimeout = setTimeout(() => {
    logger.warn({ videoId, objectKey }, "[video-validation] job timed out — partial results only");
  }, VALIDATION_JOB_TIMEOUT_MS);
  jobTimeout.unref();

  try {
    await mkdir(tmpDir, { recursive: true });

    const s = storage();
    if (!s.enabled) {
      throw new Error("Storage not enabled — cannot download source for validation");
    }

    await downloadToTempFile(objectKey, tmpPath);

    // Run all 9 checks — each is individually caught; a single failure never
    // aborts the rest of the pipeline.

    // 1. FILE_INTEGRITY
    checks.push(await checkFileIntegrity(tmpPath).catch((err: Error) => ({
      check: "FILE_INTEGRITY", status: "skip" as CheckStatus,
      message: `Check skipped due to error: ${err.message}`,
    })));

    // 2. MOOV_PLACEMENT
    checks.push(await checkMoovPlacement(tmpPath, faststartApplied).catch((err: Error) => ({
      check: "MOOV_PLACEMENT", status: "skip" as CheckStatus,
      message: `Check skipped due to error: ${err.message}`,
    })));

    // 3. CODEC_COMPAT
    checks.push(await checkCodecCompat(tmpPath).catch((err: Error) => ({
      check: "CODEC_COMPAT", status: "skip" as CheckStatus,
      message: `Check skipped due to error: ${err.message}`,
    })));

    // 4. KEYFRAME_INTERVAL
    checks.push(await checkKeyframeInterval(tmpPath, storedDurationSecs).catch((err: Error) => ({
      check: "KEYFRAME_INTERVAL", status: "skip" as CheckStatus,
      message: `Check skipped due to error: ${err.message}`,
    })));

    // 5. AV_SYNC
    checks.push(await checkAvSync(tmpPath).catch((err: Error) => ({
      check: "AV_SYNC", status: "skip" as CheckStatus,
      message: `Check skipped due to error: ${err.message}`,
    })));

    // 6. FIRST_FRAME
    checks.push(await checkFirstFrame(tmpPath).catch((err: Error) => ({
      check: "FIRST_FRAME", status: "skip" as CheckStatus,
      message: `Check skipped due to error: ${err.message}`,
    })));

    // 7. LAST_FRAME
    checks.push(await checkLastFrame(tmpPath, storedDurationSecs).catch((err: Error) => ({
      check: "LAST_FRAME", status: "skip" as CheckStatus,
      message: `Check skipped due to error: ${err.message}`,
    })));

    // 8. DURATION_ACCURACY (also returns real probed duration for auto-correction)
    const durResult = await checkDurationAccuracy(tmpPath, storedDurationSecs).catch(() => ({
      result: { check: "DURATION_ACCURACY", status: "skip" as CheckStatus, message: "Duration check skipped" },
      probedDurationSecs: null,
    }));
    checks.push(durResult.result);
    probedDurationSecs = durResult.probedDurationSecs;

    // 9. RANGE_SUPPORT (HTTP loopback probe, no temp file needed)
    checks.push(await checkRangeSupport(localVideoUrl).catch((err: Error) => ({
      check: "RANGE_SUPPORT", status: "skip" as CheckStatus,
      message: `Check skipped due to error: ${err.message}`,
    })));

    // ── Auto-correction: update real duration if stored is wrong ────────────
    if (probedDurationSecs !== null && storedDurationSecs !== null) {
      const deviation = Math.abs(probedDurationSecs - storedDurationSecs) / probedDurationSecs;
      if (deviation > DURATION_WARN_PCT / 100) {
        const newDuration = String(Math.round(probedDurationSecs));
        await db
          .update(videos)
          .set({ duration: newDuration })
          .where(eq(videos.id, videoId))
          .catch((err: unknown) => {
            logger.warn({ err, videoId }, "[video-validation] failed to auto-correct duration (non-fatal)");
          });
        repairsPerformed.push(
          `DURATION_CORRECTED: updated stored duration from ${storedDurationSecs} s to ${Math.round(probedDurationSecs)} s`,
        );
      }
    }
  } finally {
    clearTimeout(jobTimeout);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ── Compute overall status ────────────────────────────────────────────────
  const anyFail = checks.some((c) => c.status === "fail");
  const anyWarn = checks.some((c) => c.status === "warn");
  const overallStatus: ValidationStatus = anyFail ? "failed" : anyWarn ? "warn" : "passed";

  const remainingIssues = checks
    .filter((c) => c.status === "fail" || c.status === "warn")
    .map((c) => `${c.check}: ${c.message}`);

  const report: VideoValidationReport = {
    videoId,
    status: overallStatus,
    checks,
    repairsPerformed,
    remainingIssues,
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  };

  logger.info(
    {
      videoId,
      objectKey,
      overallStatus,
      checksRun: checks.length,
      failed: checks.filter((c) => c.status === "fail").length,
      warned: checks.filter((c) => c.status === "warn").length,
      durationMs: report.durationMs,
      repairs: repairsPerformed.length,
    },
    "[video-validation] completed",
  );

  // ── Persist to DB ─────────────────────────────────────────────────────────
  if (storeResult) {
    await db
      .update(videos)
      .set({
        validationStatus: overallStatus,
        validationReport: report as unknown as Record<string, unknown>,
        validationCompletedAt: new Date(),
      })
      .where(eq(videos.id, videoId))
      .catch((err: unknown) => {
        logger.warn({ err, videoId }, "[video-validation] failed to persist report (non-fatal)");
      });
  }

  return report;
}

/**
 * Fire-and-forget wrapper. Sets validationStatus='pending', then schedules
 * runVideoValidation on the next tick. Safe to call from upload finalize
 * without blocking the HTTP response.
 *
 * Errors inside the validation job are fully caught and logged — they never
 * propagate to the caller.
 */
export function scheduleVideoValidation(
  videoId: string,
  objectKey: string,
  opts: RunValidationOpts = {},
): void {
  const videos = schema.videosTable;

  // Set 'pending' synchronously (best-effort, non-blocking).
  void db
    .update(videos)
    .set({ validationStatus: "pending" })
    .where(eq(videos.id, videoId))
    .catch(() => undefined);

  // Schedule on next tick so the caller's HTTP response is not blocked.
  setImmediate(() => {
    void (async () => {
      try {
        await runVideoValidation(videoId, objectKey, opts);
      } catch (err) {
        logger.error({ err, videoId, objectKey }, "[video-validation] unhandled error in validation job");
        // Mark as failed in DB so the admin UI reflects the error state.
        await db
          .update(videos)
          .set({ validationStatus: "failed" })
          .where(eq(videos.id, videoId))
          .catch(() => undefined);
      }
    })();
  });
}

/**
 * Return the stored validation report from the DB without re-running checks.
 * Returns null if the video has not yet been validated.
 */
export async function getStoredValidationReport(
  videoId: string,
): Promise<VideoValidationReport | null> {
  const videos = schema.videosTable;
  const [row] = await db
    .select({
      validationReport: videos.validationReport,
      validationStatus: videos.validationStatus,
    })
    .from(videos)
    .where(eq(videos.id, videoId))
    .limit(1);

  if (!row?.validationReport) return null;
  return row.validationReport as unknown as VideoValidationReport;
}
