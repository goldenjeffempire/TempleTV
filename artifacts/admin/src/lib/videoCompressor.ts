/**
 * Client-side video compression using WebCodecs API
 * Supports H.264 encoding with resolution capping, FPS normalization, and bitrate reduction.
 * Uses mp4box.js for MP4 demuxing and mp4-muxer for output muxing.
 * Falls back gracefully when WebCodecs is unavailable.
 */

import type MP4BoxType from "mp4box";
import type { Muxer as MuxerType, ArrayBufferTarget as ArrayBufferTargetType } from "mp4-muxer";

export interface CompressionOptions {
  maxHeight: number;       // cap resolution (e.g. 1080)
  targetBitrate: number;   // bits/s (e.g. 4_000_000 for 4 Mbps)
  targetFps: number;       // normalize frame rate (e.g. 30)
  hardwareAcceleration?: VideoHardwareAcceleration;
}

export interface CompressionProgress {
  phase: "analyzing" | "compressing";
  progress: number;         // 0–100
  eta: number;              // seconds
  inputSize: number;        // original file bytes
  outputSize: number;       // estimated output bytes
  compressionRatio: number; // 0–1 (fraction of original)
  fps: number;              // encoding frames/sec
}

export type ProgressCallback = (p: CompressionProgress) => void;

// ── Capability check ─────────────────────────────────────────────────────────

export function isCompressionSupported(): boolean {
  return (
    typeof VideoDecoder !== "undefined" &&
    typeof VideoEncoder !== "undefined" &&
    typeof EncodedVideoChunk !== "undefined"
  );
}

export interface ProbeResult {
  width: number;
  height: number;
  fps: number;
  durationSecs: number;
  estimatedBitrateBps: number;
  isMp4: boolean;
}

export async function probeVideo(file: File): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";

    video.onloadedmetadata = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      const durationSecs = Number.isFinite(video.duration) ? video.duration : 0;
      const estimatedBitrateBps = durationSecs > 0 ? (file.size * 8) / durationSecs : 0;
      URL.revokeObjectURL(url);
      video.src = "";
      resolve({
        width,
        height,
        fps: 30, // browsers don't expose FPS from metadata
        durationSecs,
        estimatedBitrateBps,
        isMp4: file.type === "video/mp4" || /\.(mp4|m4v|mov)$/i.test(file.name),
      });
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 0, height: 0, fps: 30, durationSecs: 0, estimatedBitrateBps: 0, isMp4: false });
    };

    video.src = url;
  });
}

export function shouldCompress(probe: ProbeResult, opts: CompressionOptions): boolean {
  if (!isCompressionSupported()) return false;
  if (!probe.isMp4) return false; // only MP4 files supported
  if (probe.height === 0) return false;
  const heightExceeds = probe.height > opts.maxHeight + 16;
  const bitrateExceeds = probe.estimatedBitrateBps > opts.targetBitrate * 1.3;
  return heightExceeds || bitrateExceeds;
}

// ── Main compress function ───────────────────────────────────────────────────

export async function compressVideo(
  file: File,
  opts: CompressionOptions,
  probe: ProbeResult,
  onProgress: ProgressCallback,
  signal: AbortSignal
): Promise<Blob> {
  // Dynamic imports — mp4box and mp4-muxer are heavy, only load when needed
  const [MP4Box, { Muxer, ArrayBufferTarget }] = await Promise.all([
    import("mp4box").then((m) => m.default as typeof MP4BoxType),
    import("mp4-muxer") as Promise<{ Muxer: typeof MuxerType; ArrayBufferTarget: typeof ArrayBufferTargetType }>,
  ]);

  return new Promise<Blob>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }

    // ── Output dimensions ────────────────────────────────────────────────────
    const scaleRatio = probe.height > opts.maxHeight ? opts.maxHeight / probe.height : 1;
    const outWidth = Math.round((probe.width * scaleRatio) / 2) * 2;   // must be even
    const outHeight = Math.round((probe.height * scaleRatio) / 2) * 2;

    // ── Muxer + target ───────────────────────────────────────────────────────
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: "avc",
        width: outWidth,
        height: outHeight,
      },
      audio: {
        codec: "aac",
        sampleRate: 48000,
        numberOfChannels: 2,
      },
      fastStart: "in-memory",
    });

    // ── VideoEncoder ─────────────────────────────────────────────────────────
    let framesEncoded = 0;
    let totalFrames = Math.max(1, Math.round(probe.durationSecs * opts.targetFps));
    let encodeStartMs = 0;

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (signal.aborted) return;
        muxer.addVideoChunk(chunk, meta);
        framesEncoded++;

        const now = Date.now();
        const elapsedSecs = (now - encodeStartMs) / 1000;
        const encFps = elapsedSecs > 0 ? framesEncoded / elapsedSecs : 0;
        const progress = Math.min(99, Math.round((framesEncoded / totalFrames) * 100));
        const remaining = totalFrames - framesEncoded;
        const eta = encFps > 0 ? remaining / encFps : 0;
        const estimatedOutput = framesEncoded > 0
          ? Math.round((opts.targetBitrate / 8) * probe.durationSecs)
          : file.size;

        onProgress({
          phase: "compressing",
          progress,
          eta,
          inputSize: file.size,
          outputSize: estimatedOutput,
          compressionRatio: estimatedOutput / file.size,
          fps: Math.round(encFps),
        });
      },
      error: (e) => reject(e),
    });

    videoEncoder.configure({
      codec: "avc1.4d401f",    // H.264 Main Profile Level 3.1 — broad device support
      width: outWidth,
      height: outHeight,
      bitrate: opts.targetBitrate,
      framerate: opts.targetFps,
      latencyMode: "quality",
      hardwareAcceleration: opts.hardwareAcceleration ?? "prefer-hardware",
    });

    // ── AudioEncoder ─────────────────────────────────────────────────────────
    let audioEncoderReady = false;
    let audioEncoder: AudioEncoder | null = null;

    const setupAudioEncoder = (sampleRate: number, channelCount: number) => {
      if (audioEncoderReady) return;
      audioEncoderReady = true;
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          if (signal.aborted) return;
          muxer.addAudioChunk(chunk, meta);
        },
        error: (e) => {
          // Non-fatal audio encoding error — log but continue
          console.warn("[VideoCompressor] Audio encoder error:", e);
        },
      });
      audioEncoder.configure({
        codec: "mp4a.40.2",  // AAC-LC
        sampleRate,
        numberOfChannels: channelCount,
        bitrate: 128_000,
      });
    };

    // ── VideoDecoder ─────────────────────────────────────────────────────────
    let videoDecoder: VideoDecoder;
    let offscreenCanvas: OffscreenCanvas | null = null;
    let ctx2d: OffscreenCanvasRenderingContext2D | null = null;
    let needsScale = false;

    const processFrame = async (frame: VideoFrame) => {
      if (signal.aborted) { frame.close(); return; }

      let frameToEncode: VideoFrame;
      if (needsScale && offscreenCanvas && ctx2d) {
        ctx2d.drawImage(frame, 0, 0, outWidth, outHeight);
        frameToEncode = new VideoFrame(offscreenCanvas, {
          timestamp: frame.timestamp,
          duration: frame.duration ?? undefined,
        });
        frame.close();
      } else {
        frameToEncode = frame;
      }

      const keyFrame = framesEncoded % (opts.targetFps * 2) === 0; // keyframe every 2s
      videoEncoder.encode(frameToEncode, { keyFrame });
      frameToEncode.close();
    };

    videoDecoder = new VideoDecoder({
      output: (frame) => {
        processFrame(frame).catch(reject);
      },
      error: (e) => reject(e),
    });

    // ── AudioDecoder ─────────────────────────────────────────────────────────
    let audioDecoder: AudioDecoder | null = null;

    const setupAudioDecoder = (codec: string, sampleRate: number, channels: number, description?: Uint8Array) => {
      if (audioDecoder) return;
      try {
        audioDecoder = new AudioDecoder({
          output: (audioData) => {
            if (signal.aborted) { audioData.close(); return; }
            setupAudioEncoder(audioData.sampleRate, audioData.numberOfChannels);
            audioEncoder?.encode(audioData);
            audioData.close();
          },
          error: () => { /* non-fatal */ },
        });

        const config: AudioDecoderConfig = { codec, sampleRate, numberOfChannels: channels };
        if (description) config.description = description;
        audioDecoder.configure(config);
      } catch {
        audioDecoder = null; // AudioDecoder not available — skip audio
      }
    };

    // ── mp4box pipeline ──────────────────────────────────────────────────────
    const mp4file = MP4Box.createFile();
    let videoTrackId = -1;
    let audioTrackId = -1;
    let videoConfigured = false;
    let pendingSamples: { isVideo: boolean; samples: MP4BoxType.MP4Sample[] }[] = [];
    let allSamplesReceived = false;
    let drainStarted = false;

    const drainAndFinalize = async () => {
      if (drainStarted) return;
      drainStarted = true;

      if (!videoConfigured) {
        reject(new Error("No video track found in file"));
        return;
      }

      // Flush all pending samples
      for (const { isVideo, samples } of pendingSamples) {
        for (const sample of samples) {
          if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }

          const chunk = new EncodedVideoChunk({
            type: sample.is_sync ? "key" : "delta",
            timestamp: (sample.cts / sample.timescale) * 1_000_000,
            duration: (sample.duration / sample.timescale) * 1_000_000,
            data: new Uint8Array(sample.data),
          });

          if (isVideo) {
            videoDecoder.decode(chunk);
          } else if (audioDecoder) {
            const aChunk = new EncodedAudioChunk({
              type: "key",
              timestamp: (sample.cts / sample.timescale) * 1_000_000,
              duration: (sample.duration / sample.timescale) * 1_000_000,
              data: new Uint8Array(sample.data),
            });
            audioDecoder.decode(aChunk);
          }
        }
      }
      pendingSamples = [];

      // Flush decoders + encoders
      try {
        await videoDecoder.flush();
        videoDecoder.close();

        if (audioDecoder) {
          await audioDecoder.flush();
          audioDecoder.close();
        }

        if (audioEncoder) {
          await audioEncoder.flush();
          audioEncoder.close();
        }

        await videoEncoder.flush();
        videoEncoder.close();

        muxer.finalize();

        const outputBuffer = target.buffer;
        const blob = new Blob([outputBuffer], { type: "video/mp4" });

        onProgress({
          phase: "compressing",
          progress: 100,
          eta: 0,
          inputSize: file.size,
          outputSize: blob.size,
          compressionRatio: blob.size / file.size,
          fps: 0,
        });

        resolve(blob);
      } catch (e) {
        reject(e);
      }
    };

    mp4file.onReady = (info: MP4BoxType.MP4Info) => {
      onProgress({ phase: "analyzing", progress: 5, eta: 0, inputSize: file.size, outputSize: file.size, compressionRatio: 1, fps: 0 });

      const videoTrack = info.videoTracks?.[0];
      const audioTrack = info.audioTracks?.[0];

      if (!videoTrack) {
        reject(new Error("No video track found"));
        return;
      }

      videoTrackId = videoTrack.id;
      totalFrames = Math.max(1, videoTrack.nb_samples);
      encodeStartMs = Date.now();

      // Determine if scaling needed
      needsScale = outWidth !== videoTrack.track_width || outHeight !== videoTrack.track_height;
      if (needsScale) {
        offscreenCanvas = new OffscreenCanvas(outWidth, outHeight);
        ctx2d = offscreenCanvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      }

      // Extract codec description (avcC / hvcC box) for VideoDecoder
      let description: Uint8Array | undefined;
      try {
        const trak = (mp4file as any).getTrackById(videoTrackId);
        const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
        const codecBox = entry?.avcC ?? entry?.hvcC ?? entry?.av1C;
        if (codecBox) {
          const stream = new (MP4Box as any).DataStream(undefined, 0, (MP4Box as any).DataStream.BIG_ENDIAN);
          codecBox.write(stream);
          description = new Uint8Array(stream.buffer, 8); // skip 8-byte box header
        }
      } catch {
        // description is optional; VideoDecoder may still work
      }

      videoDecoder.configure({
        codec: videoTrack.codec,
        codedWidth: videoTrack.track_width,
        codedHeight: videoTrack.track_height,
        ...(description ? { description } : {}),
        hardwareAcceleration: opts.hardwareAcceleration ?? "prefer-hardware",
      });
      videoConfigured = true;

      // Set up audio track if present
      if (audioTrack) {
        audioTrackId = audioTrack.id;
        let audioDesc: Uint8Array | undefined;
        try {
          const trak = (mp4file as any).getTrackById(audioTrackId);
          const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
          const esds = entry?.esds;
          if (esds) {
            const stream = new (MP4Box as any).DataStream(undefined, 0, (MP4Box as any).DataStream.BIG_ENDIAN);
            esds.write(stream);
            audioDesc = new Uint8Array(stream.buffer, 8);
          }
        } catch { /* skip */ }

        setupAudioDecoder(
          audioTrack.codec,
          audioTrack.audio?.sample_rate ?? 48000,
          audioTrack.audio?.channel_count ?? 2,
          audioDesc
        );
      }

      // Extract all samples
      mp4file.setExtractionOptions(videoTrackId, "video", { nbSamples: 1000 });
      if (audioTrackId >= 0) {
        mp4file.setExtractionOptions(audioTrackId, "audio", { nbSamples: 1000 });
      }
      mp4file.start();
    };

    mp4file.onSamples = (_id: number, user: unknown, samples: MP4BoxType.MP4Sample[]) => {
      const isVideo = user === "video";
      pendingSamples.push({ isVideo, samples });
    };

    mp4file.onFlush = () => {
      allSamplesReceived = true;
      drainAndFinalize().catch(reject);
    };

    mp4file.onError = (e: string) => reject(new Error(`mp4box error: ${e}`));

    // ── Feed file into mp4box in 4 MB chunks ────────────────────────────────
    onProgress({ phase: "analyzing", progress: 0, eta: 0, inputSize: file.size, outputSize: file.size, compressionRatio: 1, fps: 0 });

    const CHUNK = 4 * 1024 * 1024;
    let offset = 0;

    const feedChunk = async () => {
      if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      if (offset >= file.size) {
        mp4file.flush();
        return;
      }

      const slice = file.slice(offset, offset + CHUNK);
      const buf = (await slice.arrayBuffer()) as MP4BoxType.MP4ArrayBuffer;
      buf.fileStart = offset;
      offset += CHUNK;
      mp4file.appendBuffer(buf);

      onProgress({
        phase: "analyzing",
        progress: Math.min(10, Math.round((offset / file.size) * 10)),
        eta: 0,
        inputSize: file.size,
        outputSize: file.size,
        compressionRatio: 1,
        fps: 0,
      });

      // Yield to event loop so UI updates
      await new Promise((r) => setTimeout(r, 0));
      feedChunk().catch(reject);
    };

    signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });

    feedChunk().catch(reject);
  });
}
