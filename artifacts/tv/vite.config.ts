import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// Port 23876 is the Replit-assigned dev port for the TV surface, mapped in
// .replit [[ports]] (localPort=23876 externalPort=4200) and forwarded by the
// API server's dev proxy at /tv/*.  Override with PORT env var if needed.
const rawPort = process.env.PORT ?? "23876";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
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
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
      // Workspace source packages: resolved directly to their TypeScript entry
      // points so Vite can compile them without a separate build step.
      "@workspace/broadcast-sync": path.resolve(
        import.meta.dirname,
        "../../lib/broadcast-sync/src/index.ts",
      ),
      "@workspace/broadcast-types": path.resolve(
        import.meta.dirname,
        "../../lib/broadcast-types/src/index.ts",
      ),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    target: "es2020",
    cssCodeSplit: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    minify: "esbuild",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react-dom") || id.match(/[\\/]node_modules[\\/]react[\\/]/)) {
            return "react-vendor";
          }
          if (id.includes("hls.js") || id.includes("video.js") || id.includes("shaka-player")) {
            return "player-vendor";
          }
          if (id.includes("@radix-ui") || id.includes("lucide-react") || id.includes("class-variance-authority") || id.includes("tailwind-merge")) {
            return "ui-vendor";
          }
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("zod") || id.includes("date-fns")) return "utils-vendor";
          return "vendor";
        },
      },
    },
  },
  esbuild: {
    drop: process.env.NODE_ENV === "production" ? ["console", "debugger"] : [],
  },
  define: {
    // Bake a build-time ID into the JS bundle so the TV localStorage catalog
    // cache key changes on every deployment, automatically evicting stale
    // serialized data left over from the previous release. Supply
    // VITE_BUILD_ID=<git-sha> in CI for stable, reproducible keys; in local
    // dev a timestamp is used so a server restart always starts with a clean
    // cache (acceptable for development workflows).
    __BUILD_ID__: JSON.stringify(
      process.env.VITE_BUILD_ID ?? Date.now().toString(36)
    ),
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    hmr: {
      // When the TV app is accessed through the API server dev proxy at
      // port 5000, `window.location.port` = 5000 so Vite's HMR client
      // would try ws://localhost:5000/@vite/client — a path the API server
      // does not serve, triggering an infinite reconnect + 429 loop.
      // Setting clientPort to the Vite dev server's own port (23876)
      // forces the HMR WebSocket to always target the correct endpoint
      // regardless of which port the page was loaded from.
      clientPort: port,
    },
    proxy: (() => {
      // Honor `API_DEV_PORT` and otherwise default to the Replit `Start
      // application` workflow port (5000) so the TV SPA's `/api/...` calls
      // proxy to the running Fastify server in dev. Falls back to 8080 only
      // if the operator explicitly sets that override (the prior Render
      // local-dev convention).
      const apiDevPort = process.env.API_DEV_PORT ?? "5000";
      const target = `http://localhost:${apiDevPort}`;
      return {
        "/api": {
          target,
          changeOrigin: true,
          secure: false,
          // Forward WebSocket upgrades for /api/playback/ws so the TV's
          // useLiveSync hook can connect to the playback engine through the
          // same dev origin it uses for HTTP. Without this, the WS handshake
          // would 404 at the dev server and useLiveSync would loop on its
          // exponential-backoff reconnect timer.
          ws: true,
        },
        "/.well-known": {
          // Forward Android App Links / iOS Universal Links verification GETs
          // to the API server so the well-known endpoints work even when
          // testing deep-link verification against the Vite dev server.
          // The Vite fs.deny no longer blocks .well-known/ (see below), but
          // the API server's dynamic response (env-var fingerprints) is the
          // authoritative source in dev so the proxy takes precedence.
          target,
          changeOrigin: true,
          secure: false,
        },
        "/healthz": { target, changeOrigin: true, secure: false },
        "/readyz": { target, changeOrigin: true, secure: false },
      };
    })(),
    fs: {
      strict: true,
      // Deny sensitive dotfiles but explicitly allow .well-known/ so that
      // /.well-known/assetlinks.json (Android App Links) and
      // /.well-known/apple-app-site-association (iOS Universal Links) are
      // served correctly from the public/ directory in development.
      deny: ["**/.git/**", "**/.env", "**/.env.*", "**/.npmrc", "**/.gitignore"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
