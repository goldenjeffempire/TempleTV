const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// ─── Monorepo workspace resolution ──────────────────────────────────────────
// Metro needs to watch every workspace package that the mobile app imports
// directly or transitively. Without these entries the bundler cannot detect
// file changes inside the packages during `expo start`, and EAS embed bundles
// will fail to resolve the modules at all.
const workspaceRoot = path.resolve(__dirname, "../..");

config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.join(workspaceRoot, "lib/api-client-react"),
  path.join(workspaceRoot, "lib/api-zod"),
  path.join(workspaceRoot, "lib/broadcast-sync"),
  path.join(workspaceRoot, "lib/broadcast-types"),
  path.join(workspaceRoot, "lib/player-core"),
];

config.resolver = config.resolver ?? {};

// ─── Package "exports" field support ─────────────────────────────────────────
// Required so Metro can resolve subpath imports declared in a package's
// `exports` map — e.g. `@workspace/player-core/react-native` →
// `lib/player-core/src/react-native.ts`. Without this, Metro falls back to
// filesystem-only resolution and the import fails with
// "Unable to resolve …/react-native".
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ["workspace", "react-native", "default"];

// ─── Node modules paths ──────────────────────────────────────────────────────
// Tell Metro to look for node_modules in both the package directory and the
// workspace root. This is required in pnpm monorepos where packages are hoisted
// to the root node_modules/.pnpm store rather than duplicated per-package.
config.resolver.nodeModulesPaths = [
  ...(config.resolver.nodeModulesPaths ?? []),
  path.resolve(__dirname, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// ─── Workspace aliasing (monorepo safety) ────────────────────────────────────
// Map every @workspace/* package to its source directory so Metro resolves the
// TypeScript source directly instead of looking for a compiled dist/ folder
// (which doesn't exist for these source-only lib packages).
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@workspace/api-client-react": path.join(workspaceRoot, "lib/api-client-react"),
  "@workspace/api-zod": path.join(workspaceRoot, "lib/api-zod"),
  "@workspace/broadcast-sync": path.join(workspaceRoot, "lib/broadcast-sync"),
  "@workspace/broadcast-types": path.join(workspaceRoot, "lib/broadcast-types"),
  "@workspace/player-core": path.join(workspaceRoot, "lib/player-core"),
};

// ─── Web-only module stubbing for native builds ──────────────────────────────
// hls.js and shaka-player are browser-only media libraries that rely on Web
// APIs unavailable in React Native's JS environment (MSE, Worker, Blob, etc.).
//
// The require("hls.js") call in LocalVideoPlayer.tsx is inside a function body
// that begins with `if (Platform.OS !== "web") return;`, so it is NEVER
// reached at runtime on Android/iOS. However, Metro is a STATIC bundler — it
// resolves all require() / import declarations it encounters in the source
// graph regardless of any runtime Platform.OS guards. This means Metro will
// attempt to parse and bundle hls.js even for Android builds, and hls.js's
// use of web Worker threads crashes the Metro bundler worker (SIGTERM/OOM).
//
// NOTE: `config.resolver.alias` is NOT a valid Metro field and has no effect.
//       The correct mechanism is `resolveRequest`, which intercepts resolution
//       before the module is parsed, and returning `{ type: 'empty' }` tells
//       Metro to emit a no-op stub module without ever reading the file.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform !== "web") {
    if (
      moduleName === "hls.js" ||
      moduleName.startsWith("hls.js/") ||
      moduleName === "shaka-player" ||
      moduleName.startsWith("shaka-player/")
    ) {
      // Return an empty stub. require("hls.js") will yield {} at runtime.
      // LocalVideoPlayer checks `HlsClass.isSupported` which is undefined on
      // the stub — the hls.js branch is safely skipped on native builds.
      return { type: "empty" };
    }
  }

  // ─── TypeScript-ESM `.js` → `.ts` fallback ────────────────────────────────
  // Workspace lib packages (e.g. `@workspace/player-core`) are authored as
  // TypeScript ESM with explicit `.js` extensions on relative imports — the
  // canonical convention required for proper ESM output and for the
  // api-server's NodeNext module resolution. Vite (admin/TV) auto-resolves
  // these to the matching `.ts`/`.tsx` source file; Metro does not.
  //
  // This shim retries the resolution against the matching TS source file
  // when Metro's default lookup fails for a relative `.js` import — keeping
  // the workspace packages source-compatible across all four bundlers
  // without forcing a build step.
  if (
    (moduleName.startsWith("./") || moduleName.startsWith("../")) &&
    moduleName.endsWith(".js")
  ) {
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch {
      const base = moduleName.slice(0, -3);
      for (const ext of [".ts", ".tsx"]) {
        try {
          return context.resolveRequest(context, base + ext, platform);
        } catch {
          // try next extension
        }
      }
      // Final fall-through — let Metro raise the original error.
      return context.resolveRequest(context, moduleName, platform);
    }
  }

  // Fall through to Metro's default resolution for everything else.
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
