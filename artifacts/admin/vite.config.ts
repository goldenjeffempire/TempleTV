import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { createRequire } from "module";

// ── lucide-react icon stub plugin ───────────────────────────────────────────
// lucide-react@0.545.0 has two icon files missing from its ESM dist but still
// referenced in the barrel (square-dashed-kanban.js, square-dashed-mouse-
// pointer.js).  Rolldown (Vite 8) treats unresolvable re-exports as hard
// build errors.  This plugin intercepts those missing paths and serves the
// correct SVG data inline, making the fix resilient to `pnpm install` runs.
function lucideIconStubs(): Plugin {
  const KANBAN_ICON = [
    ["path", { d: "M8 7v7", key: "1x2jlm" }],
    ["path", { d: "M12 7v4", key: "xawao1" }],
    ["path", { d: "M16 7v9", key: "1hp2iy" }],
    ["path", { d: "M5 3a2 2 0 0 0-2 2", key: "y57alp" }],
    ["path", { d: "M9 3h1", key: "1yesri" }],
    ["path", { d: "M14 3h1", key: "1ec4yj" }],
    ["path", { d: "M19 3a2 2 0 0 1 2 2", key: "18rm91" }],
    ["path", { d: "M21 9v1", key: "mxsmne" }],
    ["path", { d: "M21 14v1", key: "169vum" }],
    ["path", { d: "M21 19a2 2 0 0 1-2 2", key: "1j7049" }],
    ["path", { d: "M14 21h1", key: "v9vybs" }],
    ["path", { d: "M9 21h1", key: "15o7lz" }],
    ["path", { d: "M5 21a2 2 0 0 1-2-2", key: "sbafld" }],
    ["path", { d: "M3 14v1", key: "vnatye" }],
    ["path", { d: "M3 9v1", key: "1r0deq" }],
  ];
  const MOUSE_ICON = [
    ["path", { d: "M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z", key: "xwnzip" }],
    ["path", { d: "M5 3a2 2 0 0 0-2 2", key: "y57alp" }],
    ["path", { d: "M19 3a2 2 0 0 1 2 2", key: "18rm91" }],
    ["path", { d: "M5 21a2 2 0 0 1-2-2", key: "sbafld" }],
    ["path", { d: "M9 3h1", key: "1yesri" }],
    ["path", { d: "M9 21h2", key: "1qve2z" }],
    ["path", { d: "M14 3h1", key: "1ec4yj" }],
    ["path", { d: "M3 9v1", key: "1r0deq" }],
    ["path", { d: "M21 9v2", key: "p14lih" }],
    ["path", { d: "M3 14v1", key: "vnatye" }],
  ];

  const makeIconCode = (name: string, nodes: unknown[]) => `
import createLucideIcon from '../createLucideIcon.js';
const __iconNode = ${JSON.stringify(nodes)};
const Icon = createLucideIcon(${JSON.stringify(name)}, __iconNode);
export { __iconNode, Icon as default };
`;

  const STUBS: Record<string, string> = {
    "square-dashed-kanban.js": makeIconCode("square-dashed-kanban", KANBAN_ICON),
    "square-dashed-mouse-pointer.js": makeIconCode("square-dashed-mouse-pointer", MOUSE_ICON),
  };

  // Absolute paths to the stub files already written to node_modules.
  // Resolving to real paths means Vite reads the files directly, so their
  // own relative imports (../createLucideIcon.js) resolve correctly.
  //
  // The on-disk pnpm store directory name for lucide-react is suffixed with
  // whichever React version it was resolved against (e.g.
  // `lucide-react@0.545.0_react@19.2.0`). That suffix shifts whenever the
  // workspace's React version bumps, so hard-coding it goes stale silently.
  // Resolve it dynamically via the package's own entry point instead.
  const lucideEsmEntry = _require.resolve("lucide-react/dist/esm/lucide-react.js");
  const LUCIDE_ICONS_DIR = path.resolve(path.dirname(lucideEsmEntry), "icons");

  return {
    name: "lucide-react-icon-stubs",
    enforce: "pre",
    resolveId(id, importer) {
      for (const stub of Object.keys(STUBS)) {
        if (
          id.endsWith(`/icons/${stub}`) ||
          (importer?.includes("lucide-react") && id === `./icons/${stub}`)
        ) {
          return path.join(LUCIDE_ICONS_DIR, stub);
        }
      }
    },
  };
}

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

const rawPort = process.env.PORT ?? "3000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
    lucideIconStubs(),
    react(),
    tailwindcss(),
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
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        ws: true,
        // Disable proxy-level timeout for long-lived SSE connections.
        // Without this, Vite's http-proxy library applies a default
        // proxyTimeout that silently drops SSE streams after the proxy
        // sees no data from the target for the timeout window — even
        // when the server is healthy and actively sending heartbeats
        // (which flow at the write() level, past the proxy's read
        // timeout).  0 = no timeout; the server-side zombie-check and
        // client-side watchdog handle dead connections instead.
        proxyTimeout: 0,
        configure: (proxy) => {
          // For SSE responses: mark the proxy socket as persistent and
          // disable Nagle so small heartbeat frames are flushed promptly
          // through the Vite proxy → Replit external proxy chain.
          proxy.on("proxyRes", (proxyRes, req) => {
            if ((req.headers["accept"] as string | undefined)?.includes("text/event-stream")) {
              proxyRes.socket?.setKeepAlive?.(true, 30_000);
              proxyRes.socket?.setNoDelay?.(true);
            }
          });
        },
      },
    },
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
