import * as PgClient from "@effect/sql-pg/PgClient";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import { describe, expect } from "vite-plus/test";
import { splitStatements } from "../../src/migrations.ts";
import {
  compositeType,
  domain,
  emptyExtrasState,
  extension,
  type ExtrasRename,
  type ExtrasState,
  planExtras,
  renderExtrasMigration,
  toExtrasState,
} from "../../src/tooling/index.ts";
import { testDatabaseUrl } from "./database-url.ts";

/**
 * The extras plan against a real Postgres: every statement `planExtras`
 * emits for a create, an alter and a drop runs, through the rendered
 * `migration.sql` split the way `./migrations` splits it, inside one
 * transaction the spec always rolls back, so the shared database is left as
 * the global setup migrated it. `citext` ships in Postgres's contrib, which
 * both a local server and CI's `pgvector/pgvector:pg17` image carry.
 */

const pgClient = Layer.unwrap(
  Effect.map(testDatabaseUrl, (url) => PgClient.layer({ url, maxConnections: 1 })),
);

/** The sentinel the spec's transaction fails with, so nothing it wrote survives. */
class Rollback extends Schema.TaggedError<Rollback>()("Rollback", {}) {}

/** A plan from one state to the next (with its rename hints), or a statement of the spec's own. */
type Step =
  | readonly [prev: ExtrasState, next: ExtrasState, renames?: ReadonlyArray<ExtrasRename>]
  | string;

/** Run every step in order inside one rolled-back transaction, then the probe; return the probe's result. */
const inRolledBackTransaction = <A>(
  steps: ReadonlyArray<Step>,
  probe: (sql: PgClient.PgClient) => Effect.Effect<A, SqlError>,
): Effect.Effect<A, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const seen = yield* Ref.make(Option.none<A>());
    const statements = steps.flatMap((step) =>
      P.isString(step)
        ? [step]
        : splitStatements(renderExtrasMigration(planExtras(...step).statements)),
    );
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* Effect.forEach(statements, (statement) => sql.unsafe(statement), {
            concurrency: 1,
            discard: true,
          });
          yield* Ref.set(seen, Option.some(yield* probe(sql)));
          return yield* new Rollback();
        }),
      )
      .pipe(Effect.catchTag("Rollback", () => Effect.void));
    return yield* Effect.fromOption(yield* Ref.get(seen)).pipe(Effect.orDie);
  });

const created = toExtrasState({
  extensions: [extension("citext")],
  domains: [
    domain("extras_email", "citext", {
      notNull: true,
      checks: { extras_email_has_at: "position('@' in VALUE) > 1" },
    }),
  ],
  compositeTypes: [
    compositeType(
      "extras_contact",
      { email: "extras_email", label: "text" },
      { schema: "fixture" },
    ),
  ],
});

const altered = toExtrasState({
  extensions: [extension("citext")],
  domains: [
    domain("extras_email", "citext", {
      default: "'nobody@example.com'",
      checks: { extras_email_short: "length(VALUE) < 255" },
    }),
  ],
  compositeTypes: [
    compositeType(
      "extras_contact",
      { email: "extras_email", priority: "integer" },
      { schema: "fixture" },
    ),
  ],
});

layer(pgClient, { excludeTestServices: true })((it) => {
  describe("extras plan on Postgres", () => {
    it.effect("plans both steps without issues", () =>
      Effect.sync(() => {
        expect(planExtras(emptyExtrasState, created).issues).toEqual([]);
        expect(planExtras(created, altered).issues).toEqual([]);
      }),
    );

    it.effect(
      "creates an extension, a domain over its type and a composite type over the domain",
      () =>
        Effect.gen(function* () {
          const result = yield* inRolledBackTransaction(
            [[emptyExtrasState, created]],
            (sql) =>
              sql<{ email: string }>`select (('A@B.example', 'x')::fixture.extras_contact).email`,
          );
          expect(result).toEqual([{ email: "A@B.example" }]);
        }),
    );

    it.effect("applies the in-place alters, and the domain's new check holds", () =>
      Effect.gen(function* () {
        const result = yield* inRolledBackTransaction(
          [
            [emptyExtrasState, created],
            [created, altered],
          ],
          (sql) =>
            Effect.gen(function* () {
              const attributes = yield* sql<{ attname: string }>`
            select attname from pg_attribute
            where attrelid = 'fixture.extras_contact'::regclass and attnum > 0 and not attisdropped
            order by attnum`;
              const constraints = yield* sql<{ conname: string }>`
            select conname from pg_constraint
            where contypid = 'public.extras_email'::regtype order by conname`;
              const tooLong = yield* Effect.result(sql`select repeat('a', 300)::extras_email`);
              return {
                attributes: attributes.map((row) => row.attname),
                constraints: constraints.map((row) => row.conname),
                rejectsTooLong: Result.isFailure(tooLong),
              };
            }),
        );
        expect(result).toEqual({
          attributes: ["email", "priority"],
          constraints: ["extras_email_short"],
          rejectsTooLong: true,
        });
      }),
    );

    it.effect("drops everything it created, in dependency order", () =>
      Effect.gen(function* () {
        const result = yield* inRolledBackTransaction(
          [
            [emptyExtrasState, created],
            [created, emptyExtrasState],
          ],
          (sql) => sql<{ n: number }>`
        select count(*)::int as n from pg_type
        where typname in ('extras_email', 'extras_contact', 'citext')`,
        );
        expect(result).toEqual([{ n: 0 }]);
      }),
    );

    it.effect(
      "renames a domain under a column that uses it, a composite type and its attribute, in place",
      () =>
        Effect.gen(function* () {
          const renamed = toExtrasState({
            extensions: [extension("citext")],
            domains: [
              domain("extras_mail", "citext", {
                notNull: true,
                checks: { extras_email_has_at: "position('@' in VALUE) > 1" },
              }),
            ],
            compositeTypes: [
              compositeType(
                "extras_person",
                { mail: "extras_mail", label: "text" },
                { schema: "public" },
              ),
            ],
          });
          const renames: ReadonlyArray<ExtrasRename> = [
            ["domain", "extras_email", "extras_mail"],
            ["compositeType", "fixture.extras_contact", "extras_person"],
            ["attribute", "extras_person", "email", "mail"],
          ];
          expect(planExtras(created, renamed, renames).issues).toEqual([]);
          const result = yield* inRolledBackTransaction(
            [
              [emptyExtrasState, created],
              // A drop and re-create of the domain would fail on this column.
              "create table fixture.extras_rename_probe (email extras_email)",
              "insert into fixture.extras_rename_probe values ('A@B.example')",
              [created, renamed, renames],
            ],
            (sql) => sql<{ column: string; mail: string }>`
          select pg_typeof(email)::text as column, ((email, 'x')::extras_person).mail::text as mail
          from fixture.extras_rename_probe`,
          );
          expect(result).toEqual([{ column: "extras_mail", mail: "A@B.example" }]);
        }),
    );
  });
});
