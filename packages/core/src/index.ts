/**
 * The Drizzle-free entry: the namespaces a client-bundled models package can
 * import. Every other module is a PascalCase subpath (`./Derive`, `./Query`,
 * …). See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/overview.md).
 *
 * @module index
 */

/**
 * The `dbColumn` / `dbTable` annotations, column bounds and `defineTree`; the
 * same module as the `./Annotation` subpath.
 */
export * as Annotation from "./Annotation.ts";

/**
 * Typed Postgres error classification (`UniqueViolation`, `classifyErrors`,
 * …); the same module as the `./Errors` subpath.
 */
export * as Errors from "./Errors.ts";

/**
 * The typed PostGIS helpers; the same module as the `./PostGis` subpath. The
 * one part of this entry that imports Drizzle: a client bundle that
 * tree-shakes drops it unless it reads `PostGis`.
 */
export * as PostGis from "./PostGis.ts";

/**
 * The Drizzle-free filter predicate language and its evaluator; the same
 * module as the `./Predicate` subpath.
 */
export * as Predicate from "./Predicate.ts";

/**
 * The update tri-state (set, clear, carry forward); the same module as the
 * `./Update` subpath.
 */
export * as Update from "./Update.ts";
