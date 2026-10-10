import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "build/**",
      "web/**",
      "node_modules/**",
      ".codegraph/**",
      ".ruff_cache/**",
      "coverage/**",
      "**/*.bundle.mjs",
      "cli.bundle.mjs",
      "server.bundle.mjs",
      "stats.json",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      // Legacy-noise rules: visible but non-blocking until the debt is burned down.
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "@typescript-eslint/no-require-imports": "warn", // deliberate createRequire() pattern in ESM
      "no-useless-escape": "warn", // false positives on necessary escapes in alternation regexes (/^\[|\]$/)
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
    },
  },
  prettier,
);
