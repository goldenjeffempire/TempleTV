// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // ── Ignore patterns ────────────────────────────────────────────────────────
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.expo/**",
      "**/coverage/**",
      "**/web-dist/**",
      "lib/api-zod/src/generated/**",
      "lib/api-client-react/src/generated/**",
      "artifacts/mobile/.expo/**",
      "artifacts/mobile/android/**",
      "artifacts/mobile/ios/**",
      "scripts/node_modules/**",
      "**/*.min.js",
      "**/*.d.ts",
      // Replit-managed integration files — not part of the project source
      ".replit_integration_files/**",
    ],
  },

  // ── Base JS rules ──────────────────────────────────────────────────────────
  js.configs.recommended,

  // ── TypeScript rules (syntax-only — type-aware checks live in typecheck job)
  ...tseslint.configs.recommended,

  // ── Global config for all TS/TSX files ────────────────────────────────────
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // TypeScript
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-require-imports": "warn",

      // General — relaxed to match existing codebase conventions
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      // curly: multi-line only (single-line `if (x) return;` is allowed)
      curly: ["warn", "multi-line"],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // Allow empty catch blocks — a common intentional pattern for optional cleanup
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // ── Register react-hooks plugin globally so eslint-disable comments are valid
  // in any file (e.g. lib/broadcast-sync uses the disable directive).
  {
    plugins: {
      "react-hooks": reactHooks,
    },
  },

  // ── React / Admin / TV frontends — enable react-hooks rules ───────────────
  {
    files: [
      "artifacts/admin/src/**/*.{ts,tsx}",
      "artifacts/tv/src/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },

  // ── API server — server-side; console.log is fine (Pino handles logging) ──
  {
    files: ["artifacts/api-server/src/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },

  // ── Test files — relaxed rules ─────────────────────────────────────────────
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/test/**/*.ts",
      "**/tests/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // ── Scripts directory ─────────────────────────────────────────────────────
  {
    files: ["scripts/src/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-require-imports": "off",
      // Scripts are utility scripts — allow flexible patterns
      "@typescript-eslint/no-explicit-any": "off",
      "prefer-const": "warn",
    },
  },

  // ── Config / root-level JS/MJS files ─────────────────────────────────────
  {
    files: ["*.mjs", "*.cjs", "*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
);
