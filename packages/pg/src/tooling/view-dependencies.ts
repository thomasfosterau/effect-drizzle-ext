/**
 * @copyright Thomas Foster
 *
 * **The view-on-view gate** (`DB-VIEW-001`, website #1228): fails when any
 * database view in a Drizzle schema selects from another database view.
 * Ported from the website and gardeneria applications'
 * `packages/database/scripts/check-view-dependencies.ts`.
 *
 * drizzle-kit derives migrations from a schema diff, and for views that diff
 * is only ever `DROP VIEW` + `CREATE VIEW`, emitted as two flat blocks in one
 * shared order with **no topological sort** and **no cascade**. A
 * view-on-view edge is then unmigratable two ways:
 *
 * 1. **Both ends change.** The drops come out in the create order, so a drop
 *    runs dependency-first and PostgreSQL rejects it.
 * 2. **Only the dependency changes.** The dependent view is not in the diff
 *    at all, the dependency's `DROP VIEW` still fails, and no reordering of
 *    the emitted statements can help: the one that would have to run first
 *    was never emitted.
 *
 * The only remedy once such a migration exists is hand-editing it, so the
 * constraint is pushed up into the schema: **no view may reference another
 * view**. The graph is read from drizzle-kit's own DDL — the whole schema
 * generated from an empty snapshot, one `CREATE VIEW` per view carrying the
 * exact SQL a migration would — so the gate needs no database.
 *
 * @module tooling/view-dependencies
 */

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { drizzleKit, type SchemaDiffError } from "./migration-drift.ts";

/** One view as drizzle-kit would create it. */
export interface ViewDefinition {
  readonly schema: string;
  readonly name: string;
  readonly sql: string;
}

/** A view that selects from another view. */
export interface ViewEdge {
  readonly from: ViewDefinition;
  readonly to: ViewDefinition;
}

/**
 * `CREATE [MATERIALIZED] VIEW "<schema>"."<name>"` — drizzle-kit omits the
 * schema qualifier for `public`, so the schema group is optional.
 */
const CREATE_VIEW = /^CREATE\s+(?:MATERIALIZED\s+)?VIEW\s+(?:"([^"]+)"\.)?"([^"]+)"/i;

/** `schema.name`, the identity used in messages and in reference matching. */
export const viewKey = (view: { readonly schema: string; readonly name: string }): string =>
  `${view.schema}.${view.name}`;

/** Every `CREATE VIEW` in a statement list, as {@link ViewDefinition}s. */
export const parseViewDefinitions = (
  statements: ReadonlyArray<string>,
): ReadonlyArray<ViewDefinition> =>
  statements.flatMap((statement) => {
    const match = CREATE_VIEW.exec(statement.trim());
    const name = match?.[2];
    return name === undefined ? [] : [{ schema: match?.[1] ?? "public", name, sql: statement }];
  });

/**
 * Names come out of quoted identifiers, so they may contain regex
 * metacharacters; escape them rather than let one change the pattern.
 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `definition` selects from `target`.
 *
 * Matches both spellings a definition can carry: the quoted,
 * schema-qualified form Drizzle's query builder emits (`"app"."work_view"`),
 * and the bare form a hand-written `sql.raw` FROM clause may use
 * (`app.work_view`), guarded so it cannot fire on a longer identifier ending
 * the same way. A derived table aliased with a view's *unqualified* name is
 * deliberately not a match — it names no schema, so references no view.
 * The one blind spot that leaves: a hand-written FROM naming a view
 * unqualified and leaning on `search_path`.
 */
export const referencesView = (definition: ViewDefinition, target: ViewDefinition): boolean => {
  if (viewKey(definition) === viewKey(target)) return false;
  if (definition.sql.includes(`"${target.schema}"."${target.name}"`)) return true;
  const qualified = `${escapeRegExp(target.schema)}\\.${escapeRegExp(target.name)}`;
  return new RegExp(`(^|[^\\w."])${qualified}\\b`).test(definition.sql);
};

/** Every view-on-view edge among `views`. Empty is the passing state. */
export const findViewEdges = (views: ReadonlyArray<ViewDefinition>): ReadonlyArray<ViewEdge> =>
  views.flatMap((from) =>
    views.filter((to) => referencesView(from, to)).map((to) => ({ from, to })),
  );

/** The schema has at least one view-on-view edge. */
export class ViewDependencyError extends Schema.TaggedError<ViewDependencyError>()(
  "ViewDependencyError",
  {
    edges: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
  },
) {
  override get message(): string {
    const grouped = Arr.groupBy(this.edges, (edge) => edge.from);
    const listed = Arr.sort(
      Record.toEntries(grouped).map(
        ([from, group]) =>
          `  ${from} selects from ${Arr.sort(
            group.map((edge) => edge.to),
            Order.String,
          ).join(", ")}`,
      ),
      Order.String,
    ).join("\n");
    return (
      `${this.edges.length} view-on-view dependency(ies) in the schema:\n\n${listed}\n\n` +
      "drizzle-kit emits DROP VIEW / CREATE VIEW with no topological ordering and no cascade to " +
      "unchanged dependents, so a migration touching either end of one of these edges produces a " +
      "drop order PostgreSQL rejects, fixable only by hand-editing the migration.\n" +
      "Fix: resolve the dependency against the underlying tables instead of the sibling view."
    );
  }
}

/**
 * Generate the whole schema from an empty snapshot — every view exactly as a
 * migration would create it — and assert no definition references another
 * view. Succeeds with the number of views checked.
 *
 * @example
 * ```ts
 * // An application's `db:view-dependencies` task passes its own schema module.
 * import { checkViewDependencies } from "@thomasfosterau/effect-drizzle-ext-pg/tooling";
 * import { integer, pgTable, pgView, text } from "drizzle-orm/pg-core";
 * import * as Effect from "effect/Effect";
 *
 * const article = pgTable("article", { id: integer().primaryKey(), title: text().notNull() });
 * const articleTitles = pgView("article_titles").as((qb) =>
 *   qb.select({ title: article.title }).from(article),
 * );
 *
 * const { viewCount } = await Effect.runPromise(
 *   checkViewDependencies({ schema: { article, articleTitles } }),
 * );
 * console.log(viewCount); // 1
 * ```
 */
export const checkViewDependencies = (options: {
  readonly schema: Record<string, unknown>;
}): Effect.Effect<{ readonly viewCount: number }, ViewDependencyError | SchemaDiffError> =>
  Effect.gen(function* () {
    const cur = yield* drizzleKit(() => generateDrizzleJson(options.schema));
    const empty = yield* drizzleKit(() => generateDrizzleJson({}));
    const views = parseViewDefinitions(yield* drizzleKit(() => generateMigration(empty, cur)));
    const edges = findViewEdges(views);
    if (Arr.isReadonlyArrayNonEmpty(edges)) {
      return yield* new ViewDependencyError({
        edges: edges.map((edge) => ({ from: viewKey(edge.from), to: viewKey(edge.to) })),
      });
    }
    return { viewCount: views.length };
  });
