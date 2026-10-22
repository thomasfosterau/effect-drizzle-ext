/**
 * The unit suites' one runtime boundary: every test that runs an Effect goes
 * through these two helpers, so `Effect.runPromise` / `Effect.runSync` appear
 * here and nowhere else (EF-21 keeps runtime execution at the test harness).
 *
 * `@effect/vitest`'s `it.effect` is the usual home for this; it is not in the
 * workspace catalog, so the harness is two plain functions instead.
 *
 * @module tests/harness
 */

import * as Effect from "effect/Effect";

/**
 * Runs a context-free Effect to a Promise that resolves with its success.
 *
 * A failure or defect rejects the Promise with the squashed cause, so a test
 * that expects success fails on the rejection.
 */
export const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  // oxlint-disable-next-line effect/effect-run-in-body -- the test harness is the runtime boundary EF-21 names; every suite's async run funnels through this one call
  Effect.runPromise(effect);

/**
 * Runs a synchronous, context-free Effect and returns its success.
 *
 * A failure, a defect or an asynchronous step throws, so a test that expects
 * success fails at the call.
 */
export const runSync = <A, E>(effect: Effect.Effect<A, E>): A =>
  // oxlint-disable-next-line effect/effect-run-in-body -- the test harness is the runtime boundary EF-21 names; every suite's synchronous run funnels through this one call
  Effect.runSync(effect);
