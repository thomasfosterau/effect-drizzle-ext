/**
 * @copyright Thomas Foster
 *
 * Root workspace config. Owns the repo-wide format/lint/staged passes (read
 * statically by `vp fmt` / `vp lint` / `vp staged`), the root `check`
 * aggregate, and the single `test:integration` task whose vitest projects
 * live under the package that owns them.
 *
 * Copied from the gardeneria application's root config: every comment that
 * explains a load-bearing decision is part of the standard and travels with
 * the config.
 */

import { defineConfig } from "vite-plus";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@mpsuesser/oxlint-plugin-effect";

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit).
  staged: {
    "*.{js,ts,css,json,md}": "vp check --fix",
  },
  fmt: {
    overrides: [
      {
        files: ["**/*.md"],
        options: {
          proseWrap: "never",
        },
      },
    ],
  },
  lint: {
    extends: [recommended, effect.configs.recommended],
    categories: {
      correctness: "error",
    },
    rules: {
      "eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "eslint/prefer-const": "warn",
      // The `Buffer` global is typed `any` wherever a consumer loads
      // @cloudflare/workers-types next to @types/node (every application this
      // library serves), so every call on it is unchecked there. The library
      // never reaches for it: `bytea` is `Uint8Array`, and `byteaToHex` /
      // `hexToBytea` (packages/core/src/columns.ts) replace the Buffer helpers.
      "eslint/no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "The `Buffer` global is typed `any` wherever @cloudflare/workers-types is loaded. Use Uint8Array/DataView, or byteaToHex/hexToBytea from ./columns.",
        },
      ],
      // `casting-awareness` is an awareness prompt, not a defect rule — it
      // fires on every `as`, including the narrowings Drizzle's builder types
      // structurally require (the `FluentColumn` bridge in derive.ts, the
      // widened join chain in versioned-chain.ts). Stays visible as a warning.
      "effect/casting-awareness": "warn",
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import * as Option from
      // "effect/Option"`) this library shares with its consumers.
      "effect/prefer-namespace-imports": "off",

      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/ban-ts-comment": "off",
      "unicorn/no-empty-file": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      // Build/test configs and the integration global setup are evaluated by
      // Vite and Vitest in bare Node, before any Effect runtime exists — there
      // is no `Config` provider to read from and no `FileSystem` service to
      // call, so `process.env` and `node:*` are the only things that work
      // there. The Effect preset's service rules have no satisfiable fix in
      // these files.
      {
        files: [
          "**/vite.config.ts",
          "**/vitest.config.ts",
          "**/vitest.integration.config.ts",
          "**/tests/integration/**",
        ],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/avoid-native-fetch": "off",
          "effect/effect-promise-vs-trypromise": "off",
        },
      },
    ],
    // Type-aware linting is intentionally disabled: type checking stays the
    // `check` tasks' job (native tsc, Effect-patched).
    options: {
      typeAware: false,
      typeCheck: false,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  run: {
    tasks: {
      // The CI typecheck gate, as one task: every package's `check`, plus the
      // dist-consumer check that type-checks a consumer fixture against the
      // EMITTED declarations (the declaration-emit hazard versioned-chain.ts
      // documents only shows up there). A pure graph node.
      check: {
        command: "echo 'check: every type gate green'",
        dependsOn: [
          "@thomasfosterau/effect-drizzle-ext#check",
          "@thomasfosterau/effect-drizzle-ext-pg#check",
          "@effect-drizzle-ext/dist-consumer#check",
        ],
        cache: false,
      },
      // Both packages' unit suites under one Istanbul map at
      // `coverage/coverage-final.json`, the map `fallow audit` reads
      // (`.fallowrc.json` → `health.coverage`); see vitest.coverage.config.ts.
      // Not a CI step: run it before the fallow gate (AGENTS.md →
      // Verification). cache: false — the map on disk is the point, and a
      // stale one would score the audit against old code.
      "test:coverage": {
        command: "vp test run --config vitest.coverage.config.ts --coverage",
        cache: false,
      },
      // Every package's docgen: compiles AND RUNS each JSDoc `@example`
      // (see vite.package.ts). A pure graph node, like `check`.
      docgen: {
        command: "echo 'docgen: every example compiled and ran'",
        dependsOn: [
          "@thomasfosterau/effect-drizzle-ext#docgen",
          "@thomasfosterau/effect-drizzle-ext-pg#docgen",
        ],
        cache: false,
      },
      // Runs against an EPHEMERAL LOCAL database: the global setup provisions
      // a fresh database on a reachable localhost PostgreSQL server (the
      // `postgres` service container in ci.yml) or, absent one, on a
      // `pgvector/pgvector` container started via Testcontainers — see
      // packages/pg/tests/integration/global-setup.ts. No credentials, so the
      // task runs anywhere with a Docker daemon or a local server.
      //
      // ONE task over the registered vitest projects (`test.projects` below):
      // one provisioning, one database, one verdict. Filter to one project
      // with `--project <name>`.
      //
      // cache: false — the verdict is a function of a live database the
      // fingerprint cannot see.
      //
      // VITEST_MAX_WORKERS=1: the transaction runner pins one connection per
      // fork; the suite is small enough that parallel forks buy nothing.
      "test:integration": {
        command: "VITEST_MAX_WORKERS=1 vp test run --retry=1 --no-isolate",
        cache: false,
      },
    },
  },
  test: {
    // One entry per owning package's `vitest.integration.config.ts`. A
    // project that is not listed is a suite that never runs.
    projects: ["./packages/pg/vitest.integration.config.ts"],
    globalSetup: ["packages/pg/tests/integration/global-setup.ts"],
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 2),
  },
});
