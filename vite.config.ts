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
    // Changesets writes each package's CHANGELOG.md in the Release workflow's
    // "Version Packages" PR, indenting every line of a multi-paragraph
    // changeset, blank ones included, which the formatter rejects; that PR
    // and then trunk would fail `vp check` (effect-auth#546). Generated, never
    // hand-edited, so it is not formatted.
    ignorePatterns: ["**/CHANGELOG.md"],
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

      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/ban-ts-comment": "off",
      "unicorn/no-empty-file": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
      // `@effect/vitest`'s Effect-running test blocks, so `expect` inside one
      // is inside a test.
      "vitest/no-standalone-expect": [
        "error",
        { additionalTestBlockFunctions: ["it.effect", "it.live", "it.layer"] },
      ],

      // ---- type-aware rules (oxlint-tsgolint) -------------------------------
      // At `error` everywhere but the type-erasure seams (the first override
      // below, effect-drizzle-ext#104).
      "typescript/no-unsafe-type-assertion": "error",
      "effecttsgo/unsafe-effect-type-assertion": "error",
      // This library is the binding of `effect/sql/*`, `@effect/sql-pg` and
      // the platform services drizzle-kit's tooling needs (FileSystem, Path,
      // ChildProcessSpawner): those unstable modules are its subject, so no
      // import of them can be avoided. Off here and in tsconfig.base.json.
      "effecttsgo/unstable-api-usage": "off",
      // Every class it reports is a `Schema.TaggedError`, whose literal `_tag`
      // already keeps two errors apart structurally; a brand would only add a
      // phantom member to the published declarations. Off here and in
      // tsconfig.base.json.
      "effecttsgo/schema-class-missing-brand": "off",
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
      // The type-erasure seams (effect-drizzle-ext#104, owner decision A):
      // each `// SAFETY:`-commented `as` here names a type TypeScript can't
      // compute from the runtime value that has it, and no guard can recover
      // that type, because the precision lives only in the type. Narrowing at
      // a guard-able boundary is fixed in code instead, so a new `as` in any
      // other file is an error. The 17 sites:
      // - core derive.ts (3): the `FluentColumn` bridge over the registry's
      //   widened `ColumnBuilderBase`, and `fromMeta` / `fromFields` naming
      //   the per-entry `DerivedColumns` the builder loop computes.
      // - core jsonapi/derive.ts (1): the same naming for a resource.
      // - core versioned-chain.ts (8): `makeTreeTables` (3) and
      //   `makeTreeViews` (1) naming per-level tables and views built from
      //   the runtime tree; `makeCurrentVersionView`'s untyped join chain and
      //   re-pinned view (3); `columnsOrEmpty`'s `{}` default for an inferred
      //   extras map (1).
      // - core index.ts (3): `dbColumn` / `dbColumnFor` / `dbTable` stamping
      //   the type-only phantom (never present at runtime) onto the value.
      // - core update.ts (1): `updateSetMap`'s key-filtered `UpdateSet`.
      // - pg chain.ts (1): `makeVersionChain` naming per-leaf operations.
      {
        files: [
          "packages/core/src/derive.ts",
          "packages/core/src/jsonapi/derive.ts",
          "packages/core/src/versioned-chain.ts",
          "packages/core/src/index.ts",
          "packages/core/src/update.ts",
          "packages/pg/src/chain.ts",
        ],
        rules: {
          "typescript/no-unsafe-type-assertion": "off",
          "effect/casting-awareness": "off",
        },
      },
      // The one seam no single `as` can name: `makeVersionChain`'s runtime
      // operations take the untyped `Row` and its typed surface each leaf's
      // own state, so the two share no overlap TypeScript accepts a direct
      // assertion across, and the conversion goes through `unknown`.
      {
        files: ["packages/pg/src/chain.ts"],
        rules: {
          "effect/no-chained-type-assertions": "off",
          "effect/avoid-any": "off",
        },
      },
      // The Drizzle and driver boundary for `prefer-option-over-null`
      // (effect-drizzle-ext#105): `Option` is the library's own absence
      // everywhere else, and options bags it reads itself spell an optional
      // member `readonly x?: T`. Here the shapes are someone else's:
      // - config handed to Drizzle (core index.ts's `DbColumn`, derive.ts's
      //   `DeriveOptions`, versioned-chain.ts's table and view builder
      //   config) or to `@effect/sql-pg`'s `PgPoolConfig` (pg index.ts,
      //   testing.ts's `testDatabaseLayer`) stays `?: T | undefined`: both
      //   read `undefined` as "not supplied" and would emit an `Option` as a
      //   value (wrong DDL, wrong pool config);
      // - Drizzle's own row types are `T | null` (a nullable column, a LEFT
      //   JOINed fact or keyed row, a cleared pointer), in versioned-chain.ts
      //   and pg chain.ts, and `combineFilters` (query.ts) mirrors drizzle's
      //   `and()` for `.where()`;
      // - the update tri-state (`null` clears, `undefined` carries forward)
      //   is Drizzle's SET semantics, in pg chain.ts;
      // - the tests and the dist-consumer fixture assert exactly those shapes.
      {
        files: [
          "packages/core/src/index.ts",
          "packages/core/src/derive.ts",
          "packages/core/src/query.ts",
          "packages/core/src/versioned-chain.ts",
          "packages/pg/src/index.ts",
          "packages/pg/src/testing.ts",
          "packages/pg/src/chain.ts",
          "packages/core/tests/versioned-chain.test.ts",
          "packages/core/tests/update.test.ts",
          "tests/dist-consumer/src/consumer.ts",
        ],
        rules: {
          "effect/prefer-option-over-null": "off",
        },
      },
      // Build/test configs and the integration global setup are evaluated by
      // Vite and Vitest in bare Node, before any Effect runtime exists — there
      // is no `Config` provider to read from and no `FileSystem` service to
      // call, so `process.env` and `node:*` are the only things that work
      // there. The Effect preset's service rules have no satisfiable fix in
      // these files. The integration specs themselves run under an Effect
      // runtime and read the database URL through `Config`
      // (tests/integration/database-url.ts), so they are not listed.
      {
        files: [
          "vite.package.ts",
          "**/vite.config.ts",
          "**/vitest.config.ts",
          "**/vitest.integration.config.ts",
          "packages/pg/tests/integration/global-setup.ts",
        ],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
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
      // The whole CI pipeline as ONE task, so local and CI are the same thing:
      // `.github/workflows/ci.yml` runs only `vp run ci`, once per Node
      // version in its matrix. The gates run in this order and stop at the
      // first failure (AGENTS.md → Verification lists them). Integration
      // needs a reachable PostgreSQL or Docker (see `test:integration`), and
      // the audit needs the network. cache: false — it is the verdict.
      ci: {
        command: [
          "vp check",
          "vp run --concurrency-limit 2 check",
          "vp run -r test:unit",
          "vp run test:integration",
          "vp run -r build",
          "vp run docgen",
          "pnpm audit --audit-level high",
        ].join(" && "),
        cache: false,
      },
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
