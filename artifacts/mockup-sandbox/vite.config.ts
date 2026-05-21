import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { mockupPreviewPlugin } from "./mockupPreviewPlugin";

// PORT and BASE_PATH are required when starting a dev/preview server
// (the workflow injects them) but a one-shot `vite build` produces a
// static bundle that does not bind to a port — so we only enforce the
// requirement in modes that actually start a server, and fall back to
// inert defaults during build so CI / `pnpm -r build` works without
// having to set runtime-only env vars.
const isServerCommand = (() => {
  const cmd = process.argv[2] ?? "";
  return cmd === "" || cmd === "dev" || cmd === "serve" || cmd === "preview";
})();

// Port 8081 is the Replit-assigned local port for the
// "artifacts/mockup-sandbox: Component Preview Server" workflow (mapped to
// external port 8081). The artifact workflow does not inject PORT or
// BASE_PATH, so default to the expected values here instead of throwing.
const rawPort = process.env.PORT ?? "8081";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath ?? "/",
  plugins: [
    mockupPreviewPlugin(),
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
