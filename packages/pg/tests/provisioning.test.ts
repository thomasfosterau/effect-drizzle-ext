/**
 * The provisioning resolution order (`src/provisioning.ts`, re-exported from
 * `./testing`), ported from the preferenceflow application's
 * `packages/integration-harness/tests/local-database.test.ts` and driven
 * against a fake server probe, so no PostgreSQL server and no Docker daemon
 * is needed: an explicit URL wins without probing; a reachable server yields
 * this checkout's deterministic database name; an explicit-but-unreachable
 * `PG*` target is a hard error rather than a fallback; and nothing reachable
 * with nothing configured selects the Testcontainers path. The provisioning
 * itself runs in the integration suite's global setup.
 *
 * @module packages/pg/tests/provisioning
 */

import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import {
  connectionUrl,
  type DatabaseSourceOptions,
  DatabaseUnreachable,
  InvalidDatabasePrefix,
  resolveDatabaseSource,
  type ServerProbe,
  ServerUnreachable,
  testDatabaseName,
} from "../src/testing.ts";

const MIGRATIONS_DIR = "/checkout/packages/database/migrations";
const IMAGE = "postgres:17";

/** A {@link ServerProbe} plus the admin URLs it has been asked about so far. */
const probeAnswering = (reachable: boolean): { probe: ServerProbe; asked: string[] } => {
  const asked: string[] = [];
  const probe: ServerProbe = (adminUrl) =>
    Effect.suspend(() => {
      asked.push(Redacted.value(adminUrl));
      return reachable
        ? Effect.void
        : Effect.fail(new ServerUnreachable({ cause: new Error("ECONNREFUSED") }));
    });
  return { probe, asked };
};

const resolve = (
  env: DatabaseSourceOptions["env"],
  probe: ServerProbe,
): ReturnType<typeof resolveDatabaseSource> =>
  resolveDatabaseSource({
    env,
    probe,
    migrationsDir: MIGRATIONS_DIR,
    dbNamePrefix: "app",
    image: IMAGE,
  });

describe("resolveDatabaseSource", () => {
  it("uses an explicit DATABASE_URL_TEST as-is and never probes", async () => {
    const { probe, asked } = probeAnswering(false);
    const source = await Effect.runPromise(
      resolve(
        { DATABASE_URL_TEST: "postgresql://explicit@db.example/test", PGHOST: "unreachable" },
        probe,
      ),
    );
    expect(source._tag).toBe("Explicit");
    if (source._tag !== "Explicit") throw new Error("expected an Explicit source");
    expect(Redacted.value(source.url)).toBe("postgresql://explicit@db.example/test");
    expect(asked).toEqual([]);
  });

  it("accepts DATABASE_URL as the explicit escape hatch too, with DATABASE_URL_TEST winning", async () => {
    const { probe } = probeAnswering(false);
    const only = await Effect.runPromise(
      resolve({ DATABASE_URL: "postgresql://only@db.example/app" }, probe),
    );
    expect(only._tag === "Explicit" && Redacted.value(only.url)).toBe(
      "postgresql://only@db.example/app",
    );
    const both = await Effect.runPromise(
      resolve(
        {
          DATABASE_URL_TEST: "postgresql://test@db.example/test",
          DATABASE_URL: "postgresql://app@db.example/app",
        },
        probe,
      ),
    );
    expect(both._tag === "Explicit" && Redacted.value(both.url)).toBe(
      "postgresql://test@db.example/test",
    );
  });

  it("provisions this checkout's database on a reachable server, probing the admin database", async () => {
    const { probe, asked } = probeAnswering(true);
    const source = await Effect.runPromise(
      resolve({ PGHOST: "localhost", PGPORT: "5434", PGUSER: "postgres" }, probe),
    );
    expect(asked).toEqual(["postgresql://postgres@localhost:5434/postgres"]);
    if (source._tag !== "LocalServer") throw new Error("expected a LocalServer source");
    expect(Redacted.value(source.adminUrl)).toBe("postgresql://postgres@localhost:5434/postgres");
    expect(source.database).toBe(
      await Effect.runPromise(testDatabaseName({ prefix: "app", migrationsDir: MIGRATIONS_DIR })),
    );
    expect(Redacted.value(source.url)).toBe(
      `postgresql://postgres@localhost:5434/${source.database}`,
    );
  });

  it("defaults to a trust-auth postgres@127.0.0.1:5432 when no PG* variable is set", async () => {
    const { probe, asked } = probeAnswering(true);
    await Effect.runPromise(resolve({}, probe));
    expect(asked).toEqual(["postgresql://postgres@127.0.0.1:5432/postgres"]);
  });

  it("fails hard when PG* is set explicitly but nothing answers there", async () => {
    const { probe } = probeAnswering(false);
    const error = await Effect.runPromise(
      Effect.flip(resolve({ PGHOST: "db.internal", PGPASSWORD: "s3cret" }, probe)),
    );
    expect(error).toBeInstanceOf(DatabaseUnreachable);
    expect(error.message).toMatch(/PG\* variables are set/);
    expect(error.message).toMatch(/db\.internal:5432/);
    // The password never reaches the message.
    expect(error.message).not.toMatch(/s3cret/);
    expect(error).toMatchObject({ cause: expect.any(Error) });
  });

  it("selects the Testcontainers path when nothing answers and nothing was configured", async () => {
    const { probe, asked } = probeAnswering(false);
    await expect(Effect.runPromise(resolve({}, probe))).resolves.toEqual({
      _tag: "Container",
      image: IMAGE,
    });
    expect(asked).toHaveLength(1);
  });

  it("takes the image as a parameter", async () => {
    const { probe } = probeAnswering(false);
    const source = await Effect.runPromise(
      resolveDatabaseSource({
        env: {},
        probe,
        migrationsDir: MIGRATIONS_DIR,
        dbNamePrefix: "app",
        image: "pgvector/pgvector:pg17",
      }),
    );
    expect(source).toEqual({ _tag: "Container", image: "pgvector/pgvector:pg17" });
  });
});

describe("testDatabaseName", () => {
  it("is deterministic per migrations directory and carries the prefix", async () => {
    const name = await Effect.runPromise(
      testDatabaseName({ prefix: "app", migrationsDir: MIGRATIONS_DIR }),
    );
    expect(name).toMatch(/^app_test_[0-9a-f]{8}$/);
    expect(
      await Effect.runPromise(testDatabaseName({ prefix: "app", migrationsDir: MIGRATIONS_DIR })),
    ).toBe(name);
    expect(
      await Effect.runPromise(
        testDatabaseName({ prefix: "app", migrationsDir: "/other/checkout/migrations" }),
      ),
    ).not.toBe(name);
  });

  it("is sha256 of the directory, first eight hex digits", async () => {
    // sha256("/checkout/packages/database/migrations")
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(MIGRATIONS_DIR)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(
      await Effect.runPromise(testDatabaseName({ prefix: "app", migrationsDir: MIGRATIONS_DIR })),
    ).toBe(`app_test_${digest.slice(0, 8)}`);
  });

  it("refuses a prefix that is not a lower-case identifier", async () => {
    const error = await Effect.runPromise(
      Effect.flip(testDatabaseName({ prefix: 'x"; DROP', migrationsDir: MIGRATIONS_DIR })),
    );
    expect(error).toBeInstanceOf(InvalidDatabasePrefix);
  });
});

describe("connectionUrl", () => {
  it("URL-encodes the password and omits the auth separator when there is none", () => {
    expect(Redacted.value(connectionUrl({ PGUSER: "ci", PGPASSWORD: "p@ss word" }, "db"))).toBe(
      "postgresql://ci:p%40ss%20word@127.0.0.1:5432/db",
    );
    expect(Redacted.value(connectionUrl({}, "db"))).toBe("postgresql://postgres@127.0.0.1:5432/db");
  });
});
