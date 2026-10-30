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
import effect from "@enfect/oxlint";

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
    // oxlint's built-in plugins beyond its defaults: `import`, `promise`,
    // `vitest` and `jsdoc` cover what the Effect presets don't (module
    // hygiene, promise misuse, test shape, doc-comment tags). Listing
    // `plugins` replaces the default set, so the defaults are named too.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest", "jsdoc"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
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
      // `_tag` is the discriminant of every Effect tagged union and error
      // class (and of Drizzle's `_` type carrier); reading it is the point.
      "eslint/no-underscore-dangle": ["error", { allow: ["_tag"] }],
      // Reads any two-argument `.catch(…)` as `Promise.prototype.catch`, so it
      // reports the data-first `Effect.catch(self, handler)` calls that
      // `catchConstraintViolation` / `catchUniqueViolation` are built from
      // (packages/core/src/errors.ts). This library has no promise `.catch`
      // chains for it to check; the rule cannot apply.
      "promise/valid-params": "off",
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

      // ---- type-aware rules (oxlint-tsgolint) -------------------------------
      // Allowance (effect-drizzle-ext#104): 35 sites when type-aware linting
      // was turned on, every one a `// SAFETY:`-commented narrowing at a
      // Drizzle builder or schema-annotation boundary in src/, or a
      // deliberately ill-typed `as never` fixture in a test. A new site is a
      // defect; lower the count as sites are fixed and return the rule to
      // `error` at zero.
      "typescript/no-unsafe-type-assertion": "warn",
      // Allowance (effect-drizzle-ext#104): 1 site, the `Effect` channel
      // narrowing in runInTestTransaction (packages/pg/src/testing.ts).
      "effecttsgo/unsafe-effect-type-assertion": "warn",
      // Explicit default type arguments are deliberate on the public surface:
      // `Redacted.Redacted<string>` says the secret is a connection string and
      // `Schema.Codec<unknown, unknown, never, never>` says the codec needs no
      // services, in the hover and in the emitted declarations alike.
      "typescript/no-unnecessary-type-arguments": "off",
      // Reports the standard exact-type-identity idiom
      // (`<X>() => X extends A ? 1 : 2`) the type-level tests are built on,
      // and `readDbTable`'s deliberate generic target (it replaced an
      // `unknown` parameter, which `effect/no-unknown-parameters` forbids).
      "typescript/no-unnecessary-type-parameters": "off",
      // `Record<never, never>` is the deliberate neutral default of
      // `VersionSnapshot`'s `Extra` intersection: it adds no keys.
      "typescript/no-generated-empty-object-type": "off",
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
          "vite.package.ts",
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
      // The integration specs' raw `sql<…>` rows are typed by the statement's
      // type argument, but the driver hands back what Postgres sends (a
      // `count(*)` is a string), so the `Number(…)` the rule calls redundant
      // is the conversion the assertion depends on.
      {
        files: ["**/tests/integration/**"],
        rules: {
          "typescript/no-unnecessary-type-conversion": "off",
        },
      },
      // The dist-consumer fixture spreads a Drizzle table into a plain object
      // on purpose, to hand `chronologicalOrder` a view-shaped literal.
      {
        files: ["tests/dist-consumer/**"],
        rules: {
          "typescript/no-misused-spread": "off",
        },
      },
      // These helpers own a short-lived, self-contained connection (the
      // provisioning admin client, the Drizzle services a `PgDrizzle` client
      // needs), so providing its layer at the call site is the entry point
      // `effecttsgo/strict-effect-provide` asks for; the layer never leaks
      // into the caller's requirements.
      {
        files: ["packages/pg/src/index.ts", "packages/pg/src/provisioning.ts"],
        rules: {
          "effecttsgo/strict-effect-provide": "off",
        },
      },
    ],
    // Type-aware linting through oxlint-tsgolint (the binary vite-plus
    // carries, patched by `effect-tsgo patch --oxlint`), so `vp check` also
    // runs the `typescript/*` type-aware rules and `@effect/tsgo`'s
    // `effecttsgo/*` rules. `typeCheck` reports TypeScript errors too; it
    // overlaps the `check` tasks (native tsc, Effect-patched) on the package
    // sources but also covers the root configs (vite.config.ts,
    // vite.package.ts) that no tsconfig includes, so it stays on.
    options: {
      typeAware: true,
      typeCheck: true,
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
