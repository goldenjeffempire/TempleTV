import { spawn } from "node:child_process";

/** Bounded, asynchronous health probe. Never blocks application startup. */
export function probeBinaryAvailability(
  binary: string,
  args: string[] = ["-version"],
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(available);
    };
    try {
      const child = spawn(binary, args, { stdio: "ignore", windowsHide: true });
      child.once("error", () => finish(false));
      child.once("close", (code) => finish(code === 0));
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* The health probe still fails closed. */ }
        finish(false);
      }, timeoutMs);
      timer.unref();
    } catch {
      finish(false);
    }
  });
}
