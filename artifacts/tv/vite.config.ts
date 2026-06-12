import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const rawPort = process.env.PORT ?? "4200";
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
