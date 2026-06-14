import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { createRequire } from "module";

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
