/**
 * Unit tests for `./query` — the total-count page shape, the filter
 * combinator, the bounded pagination input schema, and the raw-SQL rows
 * wrapper. No database: SQL is rendered and inspected through `PgDialect`
 * exactly as the derivation tests do, and `executeRows` is driven against a
 * stubbed `{ execute }` client (porting `execute-rows.test.ts`).
 *
 * @module tests/query
 */

import { describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  boundedPagination,
  combineFilters,
  executeRows,
  pageOf,
  pageWithTotal,
  TOTAL_COUNT_ALIAS,
} from "../src/query.ts";
import { runPromise } from "./harness.ts";

describe("pageOf", () => {
  it("maps rows to resources and reads the total off the alias", () => {
    const rows = [
      { id: "a", [TOTAL_COUNT_ALIAS]: 5 },
      { id: "b", [TOTAL_COUNT_ALIAS]: 5 },
    ];
    const page = pageOf(rows, (row) => row.id);
    expect(page).toEqual({ items: ["a", "b"], totalCount: 5 });
  });

  it("reports totalCount 0 for an empty page — the documented ambiguity", () => {
    const page = pageOf<{ id: string }, string>([], (row) => row.id);
    expect(page).toEqual({ items: [], totalCount: 0 });
  });

  it("reports totalCount 0 when rows carry no alias at all", () => {
    const page = pageOf([{ id: "a" }], (row) => row.id);
    expect(page.totalCount).toBe(0);
  });
});

describe("pageWithTotal", () => {
  it("pairs already-mapped items with the total read off separately-shaped rows", () => {
    const page = pageWithTotal(["x", "y"], [{ [TOTAL_COUNT_ALIAS]: 12 }]);
    expect(page).toEqual({ items: ["x", "y"], totalCount: 12 });
  });

  it("reports 0 for an empty rows array regardless of items", () => {
    const page = pageWithTotal(["x"], []);
    expect(page.totalCount).toBe(0);
  });
});

describe("combineFilters", () => {
  const table = pgTable("widget", { name: text("name") });
  const dialect = new PgDialect();

  /** The combined condition, failing the test when there is none. */
  const defined = (combined: ReturnType<typeof combineFilters>) =>
    Option.getOrElse(Option.fromNullishOr(combined), () =>
      expect.unreachable("expected a combined condition"),
    );

  it("returns undefined with no filters", () => {
    expect(combineFilters()).toBeUndefined();
  });

  it("returns undefined when every filter is undefined", () => {
    expect(combineFilters(undefined, undefined)).toBeUndefined();
  });

  it("passes a single filter through as the same condition", () => {
    const filter = eq(table.name, "a");
    const combined = combineFilters(filter);
    expect(combined).toBeDefined();
    expect(dialect.sqlToQuery(defined(combined))).toEqual(dialect.sqlToQuery(filter));
  });

  it("ANDs several defined filters and drops the undefined ones", () => {
    const a = eq(table.name, "a");
    const b = eq(table.name, "b");
    const combined = combineFilters(a, undefined, b);
    expect(combined).toBeDefined();
    const rendered = dialect.sqlToQuery(defined(combined));
    expect(rendered.sql).toContain(" and ");
    expect(rendered.params).toEqual(["a", "b"]);
  });
});

describe("boundedPagination", () => {
  const { Limit, Offset, Input } = boundedPagination({ maxLimit: 100, defaultLimit: 25 });
  const decodeLimit = Schema.decodeUnknownSync(Limit);
  const decodeOffset = Schema.decodeUnknownSync(Offset);
  const decodeInput = Schema.decodeUnknownSync(Input);

  it("accepts a limit at both bounds of (0, maxLimit]", () => {
    expect(decodeLimit(1)).toBe(1);
    expect(decodeLimit(100)).toBe(100);
  });

  it("rejects a limit of 0 and of maxLimit + 1", () => {
    expect(() => decodeLimit(0)).toThrow();
    expect(() => decodeLimit(101)).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() => decodeLimit(1.5)).toThrow();
  });

  it("accepts an offset of 0 and rejects a negative offset", () => {
    expect(decodeOffset(0)).toBe(0);
    expect(() => decodeOffset(-1)).toThrow();
  });

  it("applies limit/offset defaults when both are omitted", () => {
    expect(decodeInput({})).toEqual({ limit: 25, offset: 0 });
  });

  it("keeps a supplied limit and/or offset", () => {
    expect(decodeInput({ limit: 10 })).toEqual({ limit: 10, offset: 0 });
    expect(decodeInput({ offset: 20 })).toEqual({ limit: 25, offset: 20 });
    expect(decodeInput({ limit: 10, offset: 20 })).toEqual({ limit: 10, offset: 20 });
  });

  it("still enforces the bound on a limit supplied through Input", () => {
    expect(() => decodeInput({ limit: 0 })).toThrow();
    expect(() => decodeInput({ limit: 101 })).toThrow();
  });
});

describe("executeRows", () => {
  interface Row {
    readonly id: string;
  }
  interface PgResult {
    readonly rows: ReadonlyArray<Row>;
    readonly rowCount: number;
  }
  /** What `pg` can resolve `execute` with: a Result, rows, several Results, or a rows-less object. */
  type ExecuteResult =
    | PgResult
    | ReadonlyArray<Row>
    | ReadonlyArray<PgResult>
    | { readonly command: string };

  /** Stub client whose `execute` resolves with one of those runtime results. */
  const clientResolving = (value: ExecuteResult): Parameters<typeof executeRows>[0] => ({
    execute: () => Effect.succeed(value),
  });

  const ROWS = [{ id: "a" }, { id: "b" }];

  it("unwraps a pg.Result-shaped object to its rows (today's raw-mode runtime shape)", async () => {
    const rows = await runPromise(
      executeRows<{ id: string }>(clientResolving({ rows: ROWS, rowCount: 2 }), "SELECT 1"),
    );
    expect(rows).toEqual(ROWS);
  });

  it("passes a bare rows array through unchanged (the typed shape)", async () => {
    const rows = await runPromise(executeRows<{ id: string }>(clientResolving(ROWS), "SELECT 1"));
    expect(rows).toEqual(ROWS);
  });

  it("degrades a rows-less object to an empty array", async () => {
    const rows = await runPromise(
      executeRows<{ id: string }>(clientResolving({ command: "SELECT" }), "SELECT 1"),
    );
    expect(rows).toEqual([]);
  });

  it("treats an array of pg.Result objects as rows — the documented single-statement boundary", async () => {
    // Multi-statement queries make `pg` resolve an ARRAY of Result objects.
    // This helper deliberately does not unwrap that shape (no call site
    // issues multi-statement reads); this pins the boundary as documented
    // behaviour rather than silent misinterpretation.
    const multi = [
      { rows: [ROWS[0]], rowCount: 1 },
      { rows: [ROWS[1]], rowCount: 1 },
    ];
    const rows = await runPromise(
      executeRows<{ id: string }>(clientResolving(multi), "SELECT 1; SELECT 2"),
    );
    expect(rows).toBe(multi);
  });
});
