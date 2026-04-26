/**
 * Babel configuration for the Temple TV mobile app (Expo SDK 54, React Native 0.81).
 *
 * - `babel-preset-expo` is the only preset required. It transparently includes
 *   the React Native preset, the JSX transform, the React Compiler plugin
 *   (gated by `react-strict-dom` / experimental flags), and — because
 *   `app.json` sets `newArchEnabled: true` — automatically wires up
 *   `react-native-worklets/plugin` for Reanimated v4. Adding the worklets
 *   plugin manually here would double-apply it and silently break animations,
 *   so it is intentionally omitted.
 *
 * - `unstable_transformImportMeta: true` enables Babel to lower `import.meta`
 *   syntax used by some ESM-only dependencies (notably newer Expo internals
 *   and `expo-router`). Without it, Metro bundling fails with
 *   "Support for the experimental syntax 'importMeta' isn't currently enabled".
 *
 * - `api.cache(true)` opts in to Babel's permanent in-memory cache for this
 *   config. The config is deterministic (no env-dependent branches), so a
 *   permanent cache is correct and gives the largest Metro speedup.
 *
 * If you ever need environment-conditional plugins (e.g. `transform-remove-console`
 * for production), switch to `api.cache.using(() => process.env.NODE_ENV)` and
 * branch on `api.env()`.
 */
module.exports = function babelConfig(api) {
  api.cache(true);

  return {
    presets: [
      [
        "babel-preset-expo",
        {
          unstable_transformImportMeta: true,
        },
      ],
    ],
  };
};
