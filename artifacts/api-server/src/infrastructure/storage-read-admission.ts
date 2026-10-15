let pausedUntil = 0;

/** Automatically expires even if a relief pass throws before cleanup. */
export function pauseStorageReadAdmission(durationMs: number): void {
  pausedUntil = Math.max(pausedUntil, Date.now() + durationMs);
}

export function assertStorageReadAdmission(): void {
  const remaining = pausedUntil - Date.now();
  if (remaining > 0) {
    throw Object.assign(new Error("Media reads temporarily paused for memory recovery"), {
      code: "STORAGE_MEMORY_PRESSURE",
      statusCode: 503,
      retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)),
    });
  }
}
