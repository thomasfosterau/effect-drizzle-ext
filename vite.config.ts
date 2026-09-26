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

      // ---- Effect preset: ported-code allowances ---------------------------
      // The modules under packages/*/src are ports of code the applications
      // carry today, which predates the Effect oxlint preset. The rules below
      // sit at `warn` so the verbatim ports stay committable while each site
      // stays reported; a new site is a defect, not headroom. `prefer-option-
      // over-null` is NOT here: it stays at `error`, because every deliberate
      // `undefined` on a Drizzle-facing member carries a written justification
      // (the Drizzle-reads-undefined-as-not-supplied hazard) in an
      // `oxlint-disable` block, and that discipline is the point.
      "effect/imperative-loops": "warn",
      "effect/avoid-native-object-helpers": "warn",
      "effect/avoid-non-null-assertion": "warn",
      "effect/avoid-any": "warn",
      "effect/avoid-untagged-errors": "warn",
      "effect/avoid-direct-json": "warn",
      "effect/prefer-arr-match": "warn",
      "effect/no-length-comparison": "warn",
      "effect/prefer-arr-sort": "warn",
      "effect/avoid-try-catch": "warn",
      "effect/yield-in-for-loop": "warn",
      "effect/prefer-effect-is": "warn",
      "effect/avoid-expect-in-if": "warn",
      "effect/effect-run-in-body": "warn",
      "effect/prefer-effect-fn": "warn",
      "effect/avoid-direct-tag-checks": "warn",
      "effect/avoid-option-getorthrow": "warn",
      "effect/no-barrel-imports": "warn",
      "effect/throw-in-effect-gen": "warn",
      // Added to `effect.configs.recommended` (at `error`) by
      // @mpsuesser/oxlint-plugin-effect 0.5; staged the same way, as
      // effect-jsonapi staged them. Counted at the bump (`vp lint`,
      // 2026-09-25): 69 `require-safety-comment-for-type-assertion`, 20
      // `no-unknown-parameters`, 12 `no-unsafe-dictionary-type`, 12
      // `no-known-value-widening`, 10 `no-unknown-returns`, 9
      // `no-runtime-typeof`, 9 `no-chained-type-assertions`, 3
      // `no-shape-in-symbol-names`, 2 `no-conditional-empty-object-spread`,
      // 1 `no-object-parameters`. Flip each back to `error` (and delete its
      // line) when its count reaches zero.
      "effect/require-safety-comment-for-type-assertion": "warn",
      "effect/no-unknown-parameters": "warn",
      "effect/no-unsafe-dictionary-type": "warn",
      "effect/no-known-value-widening": "warn",
      "effect/no-unknown-returns": "warn",
      "effect/no-runtime-typeof": "warn",
      "effect/no-chained-type-assertions": "warn",
      "effect/no-conditional-empty-object-spread": "warn",
      "effect/no-object-parameters": "warn",
      "effect/no-shape-in-symbol-names": "warn",
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
