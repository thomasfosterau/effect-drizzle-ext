# @thomasfosterau/effect-drizzle-ext-kit

## 0.6.0

### Minor Changes

- [#221](https://github.com/thomasfosterau/effect-drizzle-ext/pull/221) [`ea1312f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/ea1312f8b85fa47445e51c533db3acec22aa302d) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - New package: `effect-drizzle-kit`, a command-line companion to drizzle-kit (effect-drizzle-ext#216). `effect-drizzle-kit generate --name <slug>` writes the extensions, domains and composite types an `effect-drizzle-kit.config.ts` declares into a drizzle-kit custom migration, and `effect-drizzle-kit check` fails when they drifted from the committed migrations. When the config names its Drizzle schema module, `check` also runs the migration-drift gate. The library entry exports `defineConfig`, `loadConfig`, the `generate` / `check` Effects and the `cli` command.

### Patch Changes

- [#231](https://github.com/thomasfosterau/effect-drizzle-ext/pull/231) [`88acad6`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/88acad6f4177d898bfb9cae0f3cd0158f1578cc4) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Doc comments are shorter and no longer cite issues; module overviews link to the guides.
- Updated dependencies [[`2a12e8c`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/2a12e8c058feedee5b37278eed2590099acdd4f4), [`88acad6`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/88acad6f4177d898bfb9cae0f3cd0158f1578cc4), [`202a16d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/202a16d3fddce7a88614a507b78f2fe69894b681), [`555f97e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/555f97e0c88314bb25442f27e0aa3db88a963a2b), [`7ef6279`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/7ef62795d5747cb68a09dd3faef6df271395a484), [`47ffbce`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/47ffbce833f5f8a2575dad9aaecce54066895533)]:
  - @thomasfosterau/effect-drizzle-ext-pg@0.6.0
