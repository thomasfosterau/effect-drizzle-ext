/**
 * Root workspace config: the repo-wide format, lint and staged passes, the
 * aggregate tasks, and the integration run (whose vitest project lives in
 * packages/pg).
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
    // Written by Changesets in a shape the formatter rejects; never hand-edited.
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

      "vite-plus/prefer-vite-plus-imports": "error",
      // `@effect/vitest`'s Effect-running test blocks, so `expect` inside one
      // is inside a test.
      "vitest/no-standalone-expect": [
        "error",
        { additionalTestBlockFunctions: ["it.effect", "it.effect.each", "it.live", "it.layer"] },
      ],

      // ---- type-aware rules (tsrs) ------------------------------------------
      // At `error` everywhere but the type-erasure seams (the first override below).
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
      // The type-erasure seams: each `// SAFETY:`-commented `as` here names a
      // type TypeScript can't compute from the runtime value (per-level tables
      // built from a runtime tree, derived column maps, type-only phantoms),
      // and no guard can recover it. A new `as` anywhere else is an error.
      {
        files: [
          "packages/core/src/query-functions.ts",
          "packages/core/src/derive.ts",
          "packages/core/src/jsonapi/derive.ts",
          "packages/core/src/versioned-chain.ts",
          "packages/core/src/index.ts",
          "packages/core/src/update.ts",
          "packages/pg/src/chain.ts",
          "packages/pg/src/locate.ts",
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
      // The replay seam of `./query-functions`: a deferred query records
      // member reads and calls on a Proxy and replays them onto whatever
      // handle the context holds, so the values it passes along (a member,
      // its receiver, a call's result, the replayed builder's Effect) are
      // typed by the binding's surface, never by this file. `unknown` is the
      // honest type at each step; the replayed Effect's error and requirement
      // channels are re-typed by that surface, not here.
      {
        files: ["packages/core/src/query-functions.ts"],
        rules: {
          "effect/no-unknown-parameters": "off",
          "effect/no-unknown-returns": "off",
          "effecttsgo/any-unknown-in-error-context": "off",
        },
      },
      // The Drizzle and driver boundary for `prefer-option-over-null`: config
      // handed to Drizzle or `PgPoolConfig` stays `?: T | undefined` (both read
      // `undefined` as "not supplied" and would emit an `Option` as a value),
      // Drizzle's row types are `T | null`, and the update tri-state (`null`
      // clears, `undefined` carries forward) is Drizzle's SET semantics.
      {
        files: [
          "packages/core/src/index.ts",
          "packages/core/src/derive.ts",
          "packages/core/src/query.ts",
          "packages/core/src/versioned-chain.ts",
          "packages/core/src/Predicate.ts",
          "packages/pg/src/index.ts",
          "packages/pg/src/testing.ts",
          "packages/pg/src/chain.ts",
          "packages/core/tests/versioned-chain.test.ts",
          "packages/core/tests/update.test.ts",
          "packages/pg/tests/query-functions.test.ts",
          "tests/dist-consumer/src/consumer.ts",
        ],
        rules: {
          "effect/prefer-option-over-null": "off",
        },
      },
      // Evaluated by Vite and Vitest in bare Node, before any Effect runtime
      // exists, so `process.env` and `node:*` are the only options.
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
    // `typeCheck` stays off: vite-plus 1.7.0's tsrs (TypeScript 7.1 beta)
    // reports every Effect language-service warning as an error, which
    // `ignoreEffectWarningsInTscExitCode` can't relax and no override can
    // scope, and it flags a cast in `versioned-chain.ts` that the pinned
    // `tsc` accepts. `vp run check` is the type gate.
    options: {
      typeAware: true,
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
      // Everything CI runs, in order, stopping at the first failure.
      // Integration needs PostgreSQL or Docker; the audit needs the network.
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
      // Every package's `check`, plus the dist-consumer check against the
      // emitted declarations.
      check: {
        command: "echo 'check: every type gate green'",
        dependsOn: [
          "@thomasfosterau/effect-drizzle-ext#check",
          "@thomasfosterau/effect-drizzle-ext-pg#check",
          "@thomasfosterau/effect-drizzle-ext-kit#check",
          "@effect-drizzle-ext/dist-consumer#check",
        ],
        cache: false,
      },
      // Every unit suite under one Istanbul map, which `fallow audit` reads
      // (see vitest.coverage.config.ts).
      "test:coverage": {
        command: "vp test run --config vitest.coverage.config.ts --coverage",
        cache: false,
      },
      // Every package's docgen, which compiles and runs each `@example`.
      docgen: {
        command: "echo 'docgen: every example compiled and ran'",
        dependsOn: [
          "@thomasfosterau/effect-drizzle-ext#docgen",
          "@thomasfosterau/effect-drizzle-ext-pg#docgen",
          "@thomasfosterau/effect-drizzle-ext-kit#docgen",
        ],
        cache: false,
      },
      // Against a fresh database on a local PostgreSQL (`PG*`), else a
      // Testcontainers one (packages/pg/tests/integration/global-setup.ts).
      // One connection per fork, so one fork.
      "test:integration": {
        command: "VITEST_MAX_WORKERS=1 vp test run --retry=1 --no-isolate",
        cache: false,
      },
      fallow: {
        command: "vp exec fallow --summary",
        cache: false,
      },
      // Run by the pre-commit hook; reads the coverage map.
      "fallow:audit": {
        command: "vp exec fallow audit --base origin/trunk --quiet",
        dependsOn: ["test:coverage"],
        cache: false,
      },
      // The publish job's script (.github/workflows/release.yml): pnpm
      // publishes each public package whose version isn't on npm yet, in
      // dependency order, under OIDC trusted publishing; then `changeset
      // git-tag` tags each untagged version and reports the tags to
      // `changesets/action` through `CHANGESETS_OUTPUT`, which pushes them and
      // creates the GitHub releases. A failed publish stops before tagging; a
      // re-run publishes only what is missing. Uncached, so it sees the job's
      // full environment. Depends only on the builds: nothing that installs or
      // fetches packages runs in the job that holds `id-token: write`.
      release: {
        command: [
          "vp pm publish -r --access public --no-git-checks -- --ignore-scripts",
          "changeset git-tag",
        ],
        dependsOn: [
          "@thomasfosterau/effect-drizzle-ext#build",
          "@thomasfosterau/effect-drizzle-ext-pg#build",
          "@thomasfosterau/effect-drizzle-ext-kit#build",
        ],
        cache: false,
      },
      // What `release` would publish, without publishing or tagging.
      "release:dry-run": {
        command: "vp pm publish -r --access public --dry-run --no-git-checks -- --ignore-scripts",
        dependsOn: [
          "@thomasfosterau/effect-drizzle-ext#build",
          "@thomasfosterau/effect-drizzle-ext-pg#build",
          "@thomasfosterau/effect-drizzle-ext-kit#build",
        ],
        cache: false,
      },
      "changeset:version": {
        command: "changeset version && pnpm install --lockfile-only",
        cache: false,
      },
    },
  },
  test: {
    // One entry per package's `vitest.integration.config.ts`.
    projects: ["./packages/pg/vitest.integration.config.ts"],
    globalSetup: ["packages/pg/tests/integration/global-setup.ts"],
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 2),
  },
});
