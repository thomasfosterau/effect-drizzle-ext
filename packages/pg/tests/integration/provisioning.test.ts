import pg from "pg";
import { describe, expect, it } from "vite-plus/test";

/**
 * The provisioned database is reachable and empty: the smallest possible
 * proof that the global setup ran and that every other integration spec can
 * trust `DATABASE_URL_TEST`.
 */
describe("provisioning", () => {
  it("answers a query on DATABASE_URL_TEST", async () => {
    const url = process.env.DATABASE_URL_TEST;
    expect(url).toBeDefined();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const result = await client.query<{ one: number }>("select 1::int as one");
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await client.end();
    }
  });
});
