/**
 * @copyright Thomas Foster
 *
 * The read shapes of a version chain, kept in a module of their own that
 * imports nothing from Drizzle, so the Drizzle-free entry (`.`) and
 * `./versioned-chain` export the same types: a client-bundled models package
 * names them from `.` without pulling the ORM into its module graph
 * (effect-drizzle-ext#191). Not a published subpath.
 *
 * @module version-chain-types
 */

import type * as Schema from "effect/Schema";

/**
 * The actions a version-chain row records by default: a chain appends a
 * `(version, action, timestamp)` row per edit rather than rewriting in place,
 * and a delete is a tombstone version.
 */
export type VersionAction = "create" | "update" | "delete";

/**
 * One entry in a node's append-only version chain — what a version-history
 * listing returns per row. `Action` is the chain's own action vocabulary
 * (default {@link VersionAction}).
 */
export interface VersionChainEntry<Action extends string = VersionAction> {
  /** The version number (0 is the create). */
  readonly version: bigint;
  /** The edit action this version recorded. */
  readonly action: Action;
  /** When the version was written. */
  readonly timestamp: Date;
}

/**
 * One version's reconstructed state — what a browse / compare surface shows,
 * and what a restore re-applies as a new version. Every leaf-chain domain
 * column at `(id, version)`, keyed by column name (leaf-most level wins on a
 * shared name), plus the root chain's `action` / `timestamp`. Generated
 * columns (a search vector) are opaque and belong outside `columns`.
 *
 * `Extra` carries the branch-level facts a hierarchy adds to a snapshot (a
 * content branch's visibility and draft flag, say); the library knows none of
 * them.
 */
export type VersionSnapshot<
  Action extends string = VersionAction,
  Extra extends object = Record<never, never>,
> = VersionChainEntry<Action> &
  Extra & {
    /**
     * Every leaf-chain domain column at this version, keyed by column name:
     * the select row of the consumer's leaf chain, erased (the column set is
     * the consumer's), so each value is `unknown`. Spelled as the decoded
     * type of `Schema.Record(Schema.String, Schema.Unknown)`, which is
     * exactly Drizzle's select row of an erased table
     * (`Readonly<InferSelectModel<PgTable>>`), without importing Drizzle.
     */
    readonly columns: Schema.$Record<Schema.String, Schema.Unknown>["Type"];
  };
