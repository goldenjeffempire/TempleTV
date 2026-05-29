import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { createRequire } from "module";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// Resolve d3-format to its pre-built CJS/UMD bundle so Vite/Rolldown can
// consume it without needing to rewrite the package's ESM export map.
// Using createRequire instead of a hard-coded pnpm store path makes this
// version-agnostic and portable across environments.
const _require = createRequire(import.meta.url);
const d3FormatDist = (() => {
  try {
    return _require.resolve("d3-format/dist/d3-format.js");
  } catch {
    // Fallback: walk up from the config file to the workspace root
    return path.resolve(import.meta.dirname, "../../node_modules/d3-format/dist/d3-format.js");
  }
})();

// Port 23744 is the Replit-assigned local port for the "artifacts/admin: web"
// workflow (mapped to external port 3002). The primary "Start application"
// workflow always sets PORT=5000 explicitly, so changing this default does
// not affect it. The artifact workflow does not inject PORT, so it falls
// through to this default and binds on 23744 as Replit expects.
// Override with PORT env var if needed.
const rawPort = process.env.PORT ?? "23744";
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
      "d3-format": d3FormatDist,
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
      // No `manualChunks` here on purpose. The previous custom splitter sent
      // React to `react-vendor` while sending React-consuming packages
      // (recharts, react-remove-scroll, Radix Slot pattern, etc.) to sibling
      // `vendor` / `ui-vendor` / `charts-vendor` chunks. Rollup wires those
      // as cross-chunk imports, but ES module evaluation order is NOT
      // guaranteed to load `react-vendor` before its sibling consumers when
      // the consumers' top-level code reaches for `React.Children.toArray`,
      // `React.cloneElement`, etc. In production this surfaces as a blank
      // page with `Cannot read/set properties of undefined (reading
      // 'Children')` thrown from inside `vendor.js`, with React internals
      // appearing as the trigger in the stack. Letting Rollup do automatic
      // chunking based on the real import graph eliminates the race entirely
      // and the chunk-size delta vs. the manual setup is negligible because
      // the per-route chunks are still produced via React.lazy() in App.tsx.
      output: {},
    },
  },
  esbuild: {
    drop: process.env.NODE_ENV === "production" ? ["console", "debugger"] : [],
  },
  optimizeDeps: {
    include: ["date-fns", "date-fns/locale"],
    force: false,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: (() => {
      // The dev API server listens on whatever port `Start application` was
      // launched with. The Replit workflow uses `PORT=5000`; the prior Render
      // local-dev convention used 8080. Honor an explicit override
      // (`API_DEV_PORT`) and otherwise default to the Replit workflow port so
      // the admin SPA's `/api/...` calls resolve out-of-the-box.
      const apiDevPort = process.env.API_DEV_PORT ?? "8080";
      const target = `http://localhost:${apiDevPort}`;
      return {
        // Versioned upload path (/api/v1/...) must get the extended timeout
        // BEFORE the generic /api rule, otherwise large chunk POSTs fall
        // through to the short-timeout catch-all and produce 502s.
        "/api/v1/admin/videos/upload": {
          target,
          changeOrigin: true,
          secure: false,
          timeout: 600_000,
          proxyTimeout: 600_000,
        },
        "/api/admin/videos/upload": {
          target,
          changeOrigin: true,
          secure: false,
          timeout: 600_000,
          proxyTimeout: 600_000,
        },
        // SSE streaming endpoints need infinite timeouts so the long-lived
        // event stream is never closed by the dev proxy due to inactivity.
        // These rules MUST appear before the catch-all "/api" entry.
        "/api/admin/live/events": {
          target,
          changeOrigin: true,
          secure: false,
          timeout: 0,
          proxyTimeout: 0,
        },
        "/api/broadcast/events": {
          target,
          changeOrigin: true,
          secure: false,
          timeout: 0,
          proxyTimeout: 0,
        },
        "/api": {
          target,
          changeOrigin: true,
          secure: false,
          // Forward WebSocket upgrades for /api/playback/ws so the admin
          // PlaybackClient can connect to the playback engine through the
          // same dev origin it uses for HTTP.
          ws: true,
        },
        // Health probes are served at the root (`/healthz`, `/readyz`) by
        // the Fastify server; the SPA hits `/healthz` directly through the
        // global ApiHealthContext, so route it to the same backend.
        "/healthz": { target, changeOrigin: true, secure: false },
        "/readyz": { target, changeOrigin: true, secure: false },

        // ── Mobile (Expo web) dev proxy ────────────────────────────────────
        // The Expo Metro dev server runs on port 18115. These rules make the
        // mobile app accessible at /mobile/ via the main Replit domain so the
        // Replit "Temple TV Mobile" workflow preview works without a separate
        // port URL.
        //
        // Rule 1: /mobile/* — app entry point. Strips the /mobile prefix so
        //   Expo Router sees "/" and renders the index route correctly.
        //   (Expo's public/index.html has a history.replaceState shim that
        //   also strips the prefix client-side for deep links.)
        //
        // Rule 2: /artifacts/mobile/* — Metro injects the JS bundle script at
        //   /artifacts/mobile/index.ts.bundle?..., which is served at this
        //   absolute path by the Metro dev server. No prefix rewrite needed.
        //
        // Rule 3: /assets/* — Expo image/font assets are served by Metro at
        //   /assets?unstable_path=... and /assets/<hash>. Forward these so
        //   fonts and images load correctly inside the /mobile/ preview.
        //
        // Rules 4-5: /hot and /message — Expo Metro HMR WebSocket upgrade
        //   paths. Forward so the Expo web page can receive hot updates.
        //
        // These rules are intentionally placed after /api so that API calls
        // from the admin SPA continue to reach the Fastify backend.
        "/mobile": {
          target: "http://localhost:18115",
          changeOrigin: true,
          secure: false,
          ws: true,
          rewrite: (path: string) => path.replace(/^\/mobile/, "") || "/",
        },
        "/artifacts/mobile": {
          target: "http://localhost:18115",
          changeOrigin: true,
          secure: false,
        },
        "/assets": {
          target: "http://localhost:18115",
          changeOrigin: true,
          secure: false,
        },
        "/hot": {
          target: "http://localhost:18115",
          changeOrigin: true,
          secure: false,
          ws: true,
        },
        "/message": {
          target: "http://localhost:18115",
          changeOrigin: true,
          secure: false,
          ws: true,
        },
      };
    })(),
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
