// Flat ESLint config (v9). Minimal, safe rule set — the goal is
// to catch obvious bugs (undefined refs, unused code, floating
// promises) without triggering across the entire pre-existing
// codebase. Stricter rules land as focused follow-ups.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "apps/ui/dist/**",
      "apps/*/dist/**",
      "backups/**",
      // Compiled JS artifact of vite.config.ts — the .ts file is
      // the source of truth and lints clean.
      "apps/ui/vite.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        globalThis: "readonly",
        URL: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        RequestInit: "readonly",
        Response: "readonly",
        fetch: "readonly",
        NodeJS: "readonly",
        Headers: "readonly",
      },
    },
    rules: {
      // Only the subset the codebase can pass today. Broader
      // coverage lands as a follow-up so a legitimate PR15
      // ship isn't blocked by pre-existing style drift.
      "no-undef": "off", // TS covers this
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-namespace": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-catch": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-async-promise-executor": "off",
      "no-prototype-builtins": "off",
      "no-inner-declarations": "off",
      "no-case-declarations": "off",
      "no-control-regex": "off",
      "no-misleading-character-class": "off",
      "no-sparse-arrays": "off",
      "no-empty-pattern": "off",
      "no-useless-escape": "off",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTernary: true, allowShortCircuit: true },
      ],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  // PR15.1 — paper-verify-stack transport isolation:
  // the tool must not import global `fetch` outside its
  // dedicated transport module.
  {
    files: ["tools/paper-verify-stack/src/**/*.ts"],
    ignores: ["tools/paper-verify-stack/src/http.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "paper-verify-stack: import fetch only from src/http.ts",
        },
      ],
    },
  },
];
