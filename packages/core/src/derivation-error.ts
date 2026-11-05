/**
 * The construction-time failure every module-load derivation throws. Kept in a
 * module of its own that imports nothing from Drizzle, so the Drizzle-free
 * entry (`.`, which `defineTree` lives in) and `./derive` share one class: a
 * consumer matching on it structurally, or with `instanceof`, sees the same
 * error from either. Not a published subpath.
 *
 * @module derivation-error
 */
import * as Schema from "effect/Schema";

/**
 * A construction-time derivation failure: a table or a tree could not be built
 * from its declarations (no builder registered for a column kind, a
 * `references` annotation with no resolver, numeric bounds on a column the
 * table has no column for, an unresolvable FK target, a tree level whose
 * parent is missing or forms a cycle).
 *
 * **Thrown, never failed.** Derivation runs at module load, before an Effect
 * runtime exists, so the only way to stop a misdeclared table or tree from
 * reaching production is to make its `import` fail. It is a tagged error all
 * the same, so a consumer that does catch one (a registry loader, a codegen
 * script) can match it structurally.
 */
export class DerivationError extends Schema.TaggedError<DerivationError>()("DerivationError", {
  message: Schema.String,
}) {}
