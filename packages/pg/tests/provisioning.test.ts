/**
 * The provisioning resolution order (`src/internal/provisioning.ts`, re-exported from
 * `./Testing`), ported from the preferenceflow application's
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

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterAll, assert, describe, expect, it } from "vite-plus/test";
import {
  connectionUrl,
  DatabaseUnreachable,
  InvalidDatabasePrefix,
  provisionTestDatabase,
  resolveDatabaseSource,
  type ServerProbe,
  ServerUnreachable,
  TestDatabaseConfig,
  testDatabaseName,
} from "../src/Testing.ts";

const MIGRATIONS_DIR = "/checkout/packages/database/migrations";
const IMAGE = "postgres:17";

/** The suite's runtime: the code under test needs no services, only somewhere to run. */
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => runtime.runPromise(effect);

/** The socket error a refused connection surfaces as. */
class ConnectionRefused extends Schema.TaggedError<ConnectionRefused>()("ConnectionRefused", {
  message: Schema.String,
}) {}

/** A {@link ServerProbe} plus the admin URLs it has been asked about so far. */
interface RecordingProbe {
  readonly probe: ServerProbe;
  readonly asked: string[];
}

const probeAnswering = (reachable: boolean): RecordingProbe => {
  const asked: string[] = [];
  const probe: ServerProbe = (adminUrl) =>
    Effect.suspend(() => {
      asked.push(Redacted.value(adminUrl));
      return reachable
        ? Effect.void
        : Effect.fail(
            new ServerUnreachable({ cause: new ConnectionRefused({ message: "ECONNREFUSED" }) }),
          );
    });
  return { probe, asked };
};

/** Run `effect` against `env` as the current `ConfigProvider`. */
const withEnv =
  (env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env));

const resolve = (env: Record<string, string>, probe: ServerProbe) =>
  resolveDatabaseSource({
    probe,
    migrationsDir: MIGRATIONS_DIR,
    dbNamePrefix: "app",
    image: IMAGE,
  }).pipe(withEnv(env));

/** {@link TestDatabaseConfig} read from `env`. */
const settingsFor = (env: Record<string, string>) =>
  run(TestDatabaseConfig.parse(ConfigProvider.fromEnvRecord(env)));

/** The platform services `provisionTestDatabase` requires (its migration runner reads files). */
const nodeRuntime = ManagedRuntime.make(NodeServices.layer);
afterAll(() => nodeRuntime.dispose());

describe("provisionTestDatabase", () => {
  it("hands an explicit URL back as-is, without probing, provisioning or migrating", async () => {
    const { probe, asked } = probeAnswering(false);
    const migrated: string[] = [];
    const provisioned = await nodeRuntime.runPromise(
      Effect.scoped(
        provisionTestDatabase({
          probe,
          migrationsDir: MIGRATIONS_DIR,
          dbNamePrefix: "app",
          image: IMAGE,
          applyMigrations: (url) =>
            Effect.sync(() => migrated.push(Redacted.value(url))).pipe(Effect.as(0)),
        }),
      ).pipe(withEnv({ DATABASE_URL_TEST: "postgresql://explicit@db.example/test" })),
    );
    expect(Redacted.value(provisioned.url)).toBe("postgresql://explicit@db.example/test");
    expect(provisioned.source._tag).toBe("Explicit");
    expect(asked).toEqual([]);
    expect(migrated).toEqual([]);
  });
});

describe("resolveDatabaseSource", () => {
  it("uses an explicit DATABASE_URL_TEST as-is and never probes", async () => {
    const { probe, asked } = probeAnswering(false);
    const source = await run(
      resolve(
        { DATABASE_URL_TEST: "postgresql://explicit@db.example/test", PGHOST: "unreachable" },
        probe,
      ),
    );
    expect(source._tag).toBe("Explicit");
    assert(P.isTagged(source, "Explicit"), "expected an Explicit source");
    expect(Redacted.value(source.url)).toBe("postgresql://explicit@db.example/test");
    expect(asked).toEqual([]);
  });

  it("accepts DATABASE_URL as the explicit escape hatch too, with DATABASE_URL_TEST winning", async () => {
    const { probe } = probeAnswering(false);
    const only = await run(resolve({ DATABASE_URL: "postgresql://only@db.example/app" }, probe));
    expect(P.isTagged(only, "Explicit") && Redacted.value(only.url)).toBe(
      "postgresql://only@db.example/app",
    );
    const both = await run(
      resolve(
        {
          DATABASE_URL_TEST: "postgresql://test@db.example/test",
          DATABASE_URL: "postgresql://app@db.example/app",
        },
        probe,
      ),
    );
    expect(P.isTagged(both, "Explicit") && Redacted.value(both.url)).toBe(
      "postgresql://test@db.example/test",
    );
  });

  it("provisions this checkout's database on a reachable server, probing the admin database", async () => {
    const { probe, asked } = probeAnswering(true);
    const source = await run(
      resolve({ PGHOST: "localhost", PGPORT: "5434", PGUSER: "postgres" }, probe),
    );
    expect(asked).toEqual(["postgresql://postgres@localhost:5434/postgres"]);
    assert(P.isTagged(source, "LocalServer"), "expected a LocalServer source");
    expect(Redacted.value(source.adminUrl)).toBe("postgresql://postgres@localhost:5434/postgres");
    expect(source.database).toBe(
      await run(testDatabaseName({ prefix: "app", migrationsDir: MIGRATIONS_DIR })),
    );
    expect(Redacted.value(source.url)).toBe(
      `postgresql://postgres@localhost:5434/${source.database}`,
    );
  });

  it("defaults to a trust-auth postgres@127.0.0.1:5432 when no PG* variable is set", async () => {
    const { probe, asked } = probeAnswering(true);
    await run(resolve({}, probe));
    expect(asked).toEqual(["postgresql://postgres@127.0.0.1:5432/postgres"]);
  });

  it("fails hard when PG* is set explicitly but nothing answers there", async () => {
    const { probe } = probeAnswering(false);
    const error = await run(
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
    await expect(run(resolve({}, probe))).resolves.toEqual({
      _tag: "Container",
      image: IMAGE,
    });
    expect(asked).toHaveLength(1);
  });

  it("takes the image as a parameter", async () => {
    const { probe } = probeAnswering(false);
    const source = await run(
      resolveDatabaseSource({
        probe,
        migrationsDir: MIGRATIONS_DIR,
        dbNamePrefix: "app",
        image: "pgvector/pgvector:pg17",
      }).pipe(withEnv({})),
    );
    expect(source).toEqual({ _tag: "Container", image: "pgvector/pgvector:pg17" });
  });

  it("treats an empty variable as unset", async () => {
    const { probe, asked } = probeAnswering(false);
    const source = await run(resolve({ DATABASE_URL_TEST: "", PGHOST: "" }, probe));
    expect(source._tag).toBe("Container");
    expect(asked).toEqual(["postgresql://postgres@127.0.0.1:5432/postgres"]);
  });

  it("fails with a ConfigError on a PGPORT that is not a port", async () => {
    const { probe, asked } = probeAnswering(true);
    const error = await run(Effect.flip(resolve({ PGPORT: "fifty" }, probe)));
    expect(error).toBeInstanceOf(Config.ConfigError);
    expect(asked).toEqual([]);
  });

  it("still reads a deprecated env record, ahead of the current provider", async () => {
    const { probe } = probeAnswering(false);
    const source = await run(
      resolveDatabaseSource({
        env: { DATABASE_URL: "postgresql://legacy@db.example/app" },
        probe,
        migrationsDir: MIGRATIONS_DIR,
        dbNamePrefix: "app",
        image: IMAGE,
      }).pipe(withEnv({ DATABASE_URL: "postgresql://provider@db.example/app" })),
    );
    expect(P.isTagged(source, "Explicit") && Redacted.value(source.url)).toBe(
      "postgresql://legacy@db.example/app",
    );
  });
});

describe("testDatabaseName", () => {
  it("is deterministic per migrations directory and carries the prefix", async () => {
    const name = await run(testDatabaseName({ prefix: "app", migrationsDir: MIGRATIONS_DIR }));
    expect(name).toMatch(/^app_test_[0-9a-f]{8}$/);
    expect(await run(testDatabaseName({ prefix: "app", migrationsDir: MIGRATIONS_DIR }))).toBe(
      name,
    );
    expect(
      await run(testDatabaseName({ prefix: "app", migrationsDir: "/other/checkout/migrations" })),
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
    expect(await run(testDatabaseName({ prefix: "app", migrationsDir: MIGRATIONS_DIR }))).toBe(
      `app_test_${digest.slice(0, 8)}`,
    );
  });

  it("refuses a prefix that is not a lower-case identifier", async () => {
    const error = await run(
      Effect.flip(testDatabaseName({ prefix: 'x"; DROP', migrationsDir: MIGRATIONS_DIR })),
    );
    expect(error).toBeInstanceOf(InvalidDatabasePrefix);
  });
});

describe("connectionUrl", () => {
  it("URL-encodes the password and omits the auth separator when there is none", async () => {
    const withPassword = await settingsFor({ PGUSER: "ci", PGPASSWORD: "p@ss word" });
    expect(Redacted.value(connectionUrl(withPassword.server, "db"))).toBe(
      "postgresql://ci:p%40ss%20word@127.0.0.1:5432/db",
    );
    const defaults = await settingsFor({});
    expect(Redacted.value(connectionUrl(defaults.server, "db"))).toBe(
      "postgresql://postgres@127.0.0.1:5432/db",
    );
  });
});

describe("TestDatabaseConfig", () => {
  it("holds the URLs and the password as Redacted", async () => {
    const settings = await settingsFor({
      DATABASE_URL_TEST: "postgresql://u:secret@db.example/test",
      PGPASSWORD: "s3cret",
    });
    assert(Option.isSome(settings.explicitUrl), "expected an explicit URL");
    expect(Redacted.isRedacted(settings.explicitUrl.value)).toBe(true);
    expect(Option.map(settings.server.password, Redacted.value)).toEqual(Option.some("s3cret"));
    expect(settings.server.explicit).toBe(true);
  });
});
