/**
 * What the view-equivalence specs share: a fixture view's definition as it stood before a given
 * migration (the oracle, read from the committed fixture chain), an `EXCEPT
 * ALL` both ways against it, and a decoded `EXPLAIN (FORMAT JSON)` plan.
 *
 * @module packages/pg/tests/integration/view-oracle
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import { sql, type SQL } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { AnyRelations } from "drizzle-orm/relations";
import type { PgDatabase } from "../../src/index.ts";
import { readMigrations } from "../../src/migrations.ts";

const FIXTURE_MIGRATIONS = `${import.meta.dirname}/../fixtures/migrations`;

/**
 * Each `ontology` view's definition as it stood before `migration`: its last
 * `CREATE VIEW` in the fixture chain before that migration, as the `(select
 * …)` body, keyed by view name.
 */
export const viewsBefore = async (migration: string): Promise<Readonly<Record<string, string>>> => {
  const files = ManagedRuntime.make(NodeServices.layer);
  const migrations = await files.runPromise(readMigrations(FIXTURE_MIGRATIONS));
  await files.dispose();
  const before = Arr.takeWhile(migrations, (entry) => entry.name !== migration);
  return R.fromEntries(
    Arr.flatMap(before, (entry) =>
      Arr.flatMap(entry.statements, (statement) =>
        Arr.fromOption(
          Option.map(
            Option.fromNullishOr(/^CREATE VIEW "ontology"\."(\w+)" AS (.*);$/s.exec(statement)),
            (match): [string, string] => [match[1] ?? "", match[2] ?? ""],
          ),
        ),
      ),
    ),
  );
};

/** One node of `EXPLAIN (FORMAT JSON)`'s plan tree: the fields the plan specs read. */
export interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly Alias?: string;
  readonly "Index Name"?: string;
  readonly "Parent Relationship"?: string;
  readonly Plans?: ReadonlyArray<PlanNode>;
}

const PlanNode: Schema.Codec<PlanNode> = Schema.Struct({
  "Node Type": Schema.String,
  "Relation Name": Schema.optionalKey(Schema.String),
  Alias: Schema.optionalKey(Schema.String),
  "Index Name": Schema.optionalKey(Schema.String),
  "Parent Relationship": Schema.optionalKey(Schema.String),
  Plans: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<PlanNode> => PlanNode))),
});

/** `EXPLAIN (FORMAT JSON)`'s one row: a one-element array holding the plan. */
const ExplainRow = Schema.Struct({
  "QUERY PLAN": Schema.Array(Schema.Struct({ Plan: PlanNode })),
});

/** Every node of a plan tree, depth first. */
const planNodes = (plan: PlanNode): ReadonlyArray<PlanNode> => [
  plan,
  ...Arr.flatMap(plan.Plans ?? [], planNodes),
];

/**
 * Every node of a plan tree outside its subplans, depth first: the relations
 * the query joins, not those a correlated `EXISTS` probes per row.
 */
export const joinedNodes = (plan: PlanNode): ReadonlyArray<PlanNode> => [
  plan,
  ...Arr.flatMap(
    Arr.filter(
      plan.Plans ?? [],
      (child) =>
        child["Parent Relationship"] !== "SubPlan" && child["Parent Relationship"] !== "InitPlan",
    ),
    joinedNodes,
  ),
];

/** A plan's aggregate nodes. */
export const aggregates = (nodes: ReadonlyArray<PlanNode>) =>
  Arr.filter(nodes, (n) => Str.includes("Aggregate")(n["Node Type"]));

/**
 * The ambient-transaction helpers over one spec file's database services:
 * raw statements, the `EXCEPT ALL` difference against an oracle, and plans.
 */
export const viewOracle = <Relations extends AnyRelations>(
  database: Pick<PgDatabase<Relations, "Database">, "CurrentTransaction">,
) => {
  const { CurrentTransaction } = database;
  /** One raw statement, in the ambient test transaction. */
  const exec = Effect.fn("viewOracle.exec")(function* (statement: string) {
    const tx = yield* CurrentTransaction;
    yield* tx.execute(sql.raw(statement));
  });

  /** Raw statements in order, in the ambient test transaction. */
  const execAll = (statements: ReadonlyArray<string>) =>
    Effect.forEach(statements, exec, { concurrency: 1, discard: true });

  /** The rows of `query` missing from `oracle`, plus those of `oracle` missing from `query`. */
  const difference = Effect.fn("viewOracle.difference")(function* (query: SQL, oracle: string) {
    const tx = yield* CurrentTransaction;
    const count = (sqlText: SQL) =>
      Effect.map(
        tx.execute<{ readonly n: number }>(sql`select count(*)::int as n from (${sqlText}) d`),
        (result) => Arr.map(result.rows, (row) => Number(row.n)),
      );
    const [rows] = yield* count(query);
    const [missing] = yield* count(sql`${query} except all ${sql.raw(oracle)}`);
    const [extra] = yield* count(sql`${sql.raw(oracle)} except all ${query}`);
    return { rows, missing, extra };
  });

  /** The plan PostgreSQL picks for `query`, walked by `walk`. */
  const planOf = (query: string, walk: (plan: PlanNode) => ReadonlyArray<PlanNode>) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* executeRows(tx, sql.raw(`EXPLAIN (FORMAT JSON) ${query}`), ExplainRow);
      return Arr.flatMap(rows, (result) =>
        Arr.flatMap(result["QUERY PLAN"], (explained) => walk(explained.Plan)),
      );
    });

  /** The plan PostgreSQL picks for `query`, as its node list. */
  const explain = Effect.fn("viewOracle.explain")(function* (query: string) {
    return yield* planOf(query, planNodes);
  });

  /** The nodes of `query`'s plan outside its subplans: what it joins. */
  const explainJoined = Effect.fn("viewOracle.explainJoined")(function* (query: string) {
    return yield* planOf(query, joinedNodes);
  });

  /** The plan PostgreSQL picks for `query`, as its root node. */
  const explainRoot = Effect.fn("viewOracle.explainRoot")(function* (query: string) {
    return yield* planOf(query, (plan) => [plan]);
  });

  return { exec, execAll, difference, explain, explainJoined, explainRoot };
};
