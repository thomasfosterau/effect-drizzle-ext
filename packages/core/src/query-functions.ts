/**
 * @copyright Thomas Foster
 *
 * Context-bound query functions: `select`, `insert`, `update`, `delete`,
 * `query` and the rest of a Drizzle handle's query surface as free functions
 * that find their handle in the Effect context, so a caller writes
 * `yield* select().from(users)` instead of yielding the client first and
 * writing `db.select().from(users)`.
 *
 * Each function returns a **deferred query**: a stand-in for the builder the
 * real handle would return, which records every member read and call made on
 * it (`.from(users)`, `.where(…)`, `.returning()`, `query.users.findMany(…)`)
 * and is itself an Effect. Yielding it resolves the handle, replays the
 * recording against it, and runs the real builder. Because only the public
 * builder API is replayed, the module names no driver and depends on no
 * Drizzle internals; the binding supplies the static surface (for
 * `@effect/sql-pg`, `@thomasfosterau/effect-drizzle-ext-pg`'s
 * `PgQueryFunctions`), so the builders' types are Drizzle's own, inferred
 * from the schema, with the database key added to their requirement channel.
 *
 * The handle is resolved the way {@link DatabaseServices.readHandle} resolves
 * one, for writes as well as reads: the ambient
 * {@link DatabaseServices.CurrentTransaction} when one is open, the
 * {@link DatabaseServices.Database} client otherwise. A write yielded inside
 * {@link DatabaseServices.transact} therefore lands in that transaction rather
 * than on a second pooled connection. That opens no boundary, so it is not
 * the join-if-present `transact` refuses to be: `transact` still opens a
 * SAVEPOINT every time it is called.
 *
 * @module query-functions
 */

import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { DatabaseServices, ReadSurface } from "./database.ts";

/**
 * A deferred query was used for something only a real builder can do: render
 * its SQL (`toSQL`, `getSQL`), become a subquery (`as`), or replay to a value
 * that is not an Effect.
 *
 * **Thrown** when the member is read (`toSQL`, `getSQL`, `as` after the first
 * call in the chain), because that is a programming error at the call site
 * with no runtime to fail in yet; **a defect** (`Effect.die`) when a replayed
 * chain ends in something that is not an Effect, since only yielding reveals
 * it. Neither is a typed failure: no input makes a correct program raise one.
 * Build a subquery or a CTE with Drizzle's standalone `QueryBuilder` (or the
 * handle itself) instead.
 */
export class DeferredQueryError extends Schema.TaggedError<DeferredQueryError>()(
  "DeferredQueryError",
  { message: Schema.String },
) {}

/** One recorded interaction: a member read, or a call of the value read last. */
type Step = Data.TaggedEnum<{
  Get: { readonly key: string };
  Call: { readonly args: ReadonlyArray<unknown> };
}>;
const Step = Data.taggedEnum<Step>();

/**
 * Members a deferred query refuses once the chain has been called: each one
 * hands back SQL or a subquery synchronously, which needs a real builder, and
 * a deferred one has no handle until it is yielded.
 */
const SYNCHRONOUS_MEMBERS: ReadonlyArray<string> = ["toSQL", "getSQL", "as"];

/**
 * Where a replay has got to: the value the chain has reached and the object
 * it was read from (a call's `this`), or why the chain broke.
 */
type Replay = Data.TaggedEnum<{
  At: { readonly value: unknown; readonly receiver: unknown };
  Broken: { readonly reason: string };
}>;
const Replay = Data.taggedEnum<Replay>();

/** A member of a handle, called with the object it was read from as `this`. */
type Method = (this: unknown, ...args: ReadonlyArray<unknown>) => unknown;

/** Narrows a replayed member to something callable. */
const isMethod = (value: unknown): value is Method => P.isFunction(value);

/** Renders a recorded chain for an error message: `select(…).from(…)`. */
const renderChain = (steps: ReadonlyArray<Step>): string =>
  Arr.reduce(steps, "", (path, step) =>
    Step.$match(step, {
      Get: ({ key }) => (path === "" ? key : `${path}.${key}`),
      Call: () => `${path}(…)`,
    }),
  );

/** One step of a replay: read the member, or call the value read last. */
const advance = (steps: ReadonlyArray<Step>) => (state: Replay, step: Step, index: number) =>
  Replay.$match(state, {
    Broken: () => state,
    At: ({ value, receiver }) =>
      Step.$match(step, {
        Get: ({ key }) =>
          P.hasProperty(value, key)
            ? Replay.At({ value: value[key], receiver: value })
            : Replay.Broken({
                reason: `${renderChain(Arr.take(steps, index + 1))} is not a member of the handle`,
              }),
        Call: ({ args }) =>
          isMethod(value)
            ? Replay.At({ value: value.call(receiver, ...args), receiver: undefined })
            : Replay.Broken({
                reason: `${renderChain(Arr.take(steps, index))} is not a function on the handle`,
              }),
      }),
  });

/**
 * Replays a recorded chain against a real handle. A call keeps the object its
 * function was read from as `this`, which is what every Drizzle builder method
 * expects.
 */
const replay = <Handle>(handle: Handle, steps: ReadonlyArray<Step>): Replay =>
  Arr.reduce(steps, Replay.At({ value: handle, receiver: undefined }), advance(steps));

/** The recording behind each deferred query, keyed by the proxy a caller holds. */
const recordings = new WeakMap<object, ReadonlyArray<Step>>();

/**
 * The one target every deferred query proxies: a function, so a proxy over it
 * is callable. It holds no state; each proxy's handler carries its own
 * recording and its factory's Effect prototype.
 */
const TARGET = (): undefined => undefined;

/**
 * Builds the recorder for one factory: a function from a recorded chain to the
 * deferred-query proxy for it.
 *
 * The proxy answers as an instance of `proto`, the factory's Effect prototype
 * (so it is yieldable, `pipe` is Effect's, and `Effect.isEffect` holds):
 * symbol keys, Effect's own `~`-prefixed keys and anything `proto` has
 * resolve there, and every other key is a recorded member read. `then` reads
 * as absent, so nothing mistakes a deferred query for a promise.
 */
const makeRecorder = <Proto extends object>(proto: Proto) => {
  const record = (steps: ReadonlyArray<Step>): typeof TARGET => {
    const called = Arr.some(steps, Step.$is("Call"));
    const proxy = new Proxy(TARGET, {
      getPrototypeOf: () => proto,
      has: (_target, key) => key in proto,
      get: (_target, key) => {
        if (P.isSymbol(key) || key.startsWith("~") || key in proto) {
          return P.hasProperty(proto, key) ? proto[key] : undefined;
        }
        if (key === "then") return undefined;
        if (called && Arr.contains(SYNCHRONOUS_MEMBERS, key)) {
          throw new DeferredQueryError({
            message: `${renderChain(steps)}.${key} needs a real builder; a deferred query has no handle until it is yielded. Build subqueries and SQL with Drizzle's QueryBuilder or the handle itself.`,
          });
        }
        return record([...steps, Step.Get({ key })]);
      },
      apply: (_target, _this, args: ReadonlyArray<unknown>) =>
        record([...steps, Step.Call({ args })]),
    });
    recordings.set(proxy, steps);
    return proxy;
  };
  return record;
};

/** A query as {@link QueryFunctionsOptions.mapQuery} sees it, its types erased. */
type AnyQuery = Effect.Effect<unknown, unknown, unknown>;

/** The default {@link QueryFunctionsOptions.mapQuery}: runs the query as built. */
const identityQuery = (query: AnyQuery): AnyQuery => query;

/** What a binding can add around every query {@link makeQueryFunctions} runs. */
export interface QueryFunctionsOptions {
  /**
   * Wraps the real query a deferred one replays to, just before it runs —
   * the pg binding classifies the driver's failures here (core's
   * `./errors` `classifyErrors`).
   *
   * Its types are erased, as the surface's are: the binding's `Surface`
   * type is what states the result, so a `mapQuery` that changes the error
   * channel needs a `Surface` that says so. It runs inside the query's
   * Effect, so it sees the same context.
   */
  readonly mapQuery?: (query: AnyQuery) => AnyQuery;
}

/**
 * Builds the context-bound query functions over one application's database
 * services: `select`, `insert`, `update`, `delete`, `query`, `execute` and the
 * rest of whatever surface the binding names, each finding its handle in the
 * Effect context.
 *
 * Curried in two stages for the same reason {@link makeDatabaseServices} is:
 * the first call fixes the static surface (`Surface`, which a binding writes
 * once — for `@effect/sql-pg`, `PgQueryFunctions<Relations, Key>` from
 * `@thomasfosterau/effect-drizzle-ext-pg`, which `makePgDatabase` already
 * applies as its `queries`), the second takes the services. Nothing checks
 * `Surface` against the handles at runtime: every member read is recorded, so
 * a member the handle lacks surfaces as a `DeferredQueryError` defect when the
 * query is yielded. That is why a binding, not an application, names it.
 *
 * Every query yielded through these functions requires the database key
 * (`Key`) and runs on the open `CurrentTransaction` when there is one, or the
 * `Database` client otherwise; see the module comment for why that is not a
 * join-if-present transaction. A deferred query is only for running: one
 * can't render SQL (`toSQL`) or become a subquery (`as`), and doing so throws
 * a `DeferredQueryError`. `options.mapQuery`, when given, wraps every real
 * query before it runs (see {@link QueryFunctionsOptions}).
 *
 * @example
 * ```ts
 * import { makeDatabaseServices } from "@thomasfosterau/effect-drizzle-ext/database";
 * import { makeQueryFunctions } from "@thomasfosterau/effect-drizzle-ext/query-functions";
 * import * as Effect from "effect/Effect";
 *
 * // A stand-in handle: any Effect-native driver's database fits.
 * interface Handle {
 *   readonly select: () => { readonly from: (table: string) => Effect.Effect<string> };
 *   readonly selectDistinct: unknown;
 *   readonly selectDistinctOn: unknown;
 *   readonly with: unknown;
 *   readonly $count: unknown;
 *   readonly transaction: <A, E, R>(f: (tx: Handle) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
 * }
 * const handle: Handle = {
 *   select: () => ({ from: (table) => Effect.succeed(`rows of ${table}`) }),
 *   selectDistinct: undefined,
 *   selectDistinctOn: undefined,
 *   with: undefined,
 *   $count: undefined,
 *   transaction: (f) => f(handle),
 * };
 *
 * const services = makeDatabaseServices<Handle, Handle>()({ key: "Database" });
 * interface Surface {
 *   readonly select: () => {
 *     readonly from: (table: string) => Effect.Effect<string, never, "Database">;
 *   };
 * }
 * const { select } = makeQueryFunctions<Surface>()(services);
 *
 * const program = select().from("users").pipe(Effect.provideService(services.Database, handle));
 * console.log(Effect.runSync(program)); // "rows of users"
 * ```
 */
export const makeQueryFunctions =
  <Surface extends object>() =>
  <Db, Tx extends ReadSurface, Key extends string>(
    services: Pick<DatabaseServices<Db, Tx, Key>, "Database" | "CurrentTransaction">,
    options?: QueryFunctionsOptions,
  ): Surface => {
    const mapQuery = options?.mapQuery ?? identityQuery;
    const resolve: Effect.Effect<Db | Tx, never, Key> = Effect.flatMap(
      Effect.serviceOption(services.CurrentTransaction),
      (open) =>
        Option.isSome(open)
          ? Effect.succeed<Db | Tx>(open.value)
          : Effect.map(services.Database, (db): Db | Tx => db),
    );
    const proto = Effectable.Prototype<Effect.Effect<unknown, unknown, unknown>>({
      label: "DeferredQuery",
      evaluate() {
        const steps = recordings.get(this) ?? [];
        return Effect.flatMap(resolve, (handle) =>
          Replay.$match(replay(handle, steps), {
            Broken: ({ reason }) => Effect.die(new DeferredQueryError({ message: reason })),
            At: ({ value }) =>
              Effect.isEffect(value)
                ? mapQuery(value)
                : Effect.die(
                    new DeferredQueryError({
                      message: `${renderChain(steps)} did not build a query: the handle returned a value that is not an Effect`,
                    }),
                  ),
          }),
        );
      },
    });
    // SAFETY: the proxy answers every member read with a recorder, so it has
    // whatever shape `Surface` names; the binding that names `Surface` is what
    // ties it to the handles' real query surface (see the doc comment).
    return makeRecorder(proto)([]) as Surface;
  };
