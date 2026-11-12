# `./columns`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

- `jsonbSchema(schema)(name)` — a typed `jsonb` custom column backed by an Effect Schema: writes encode through the schema then to JSON text, reads decode driver output straight through the schema (a string-typed branch is kept for a driver that hands back raw JSON text instead of a parsed value).
- `tsvector(name)` — a `tsvector` custom column, opaque to the consumer; queries use `sql` template literals to match against it.
- `bytea(name)` — a `bytea` custom column typed `Uint8Array`, never `Buffer` (a runtime that degrades the `Buffer` global, e.g. Cloudflare Workers' `nodejs_compat` types, would silently lose type checking on every `Buffer.*` call).
- `timestamps()` — a fresh `{ createdAt, updatedAt }` pair, `timestamptz NOT NULL DEFAULT now()`. A **factory**, never a shared object: Drizzle column builders are mutable, so a module-level constant reused across tables would hand every table the same two builders.
- `byteaToHex` / `hexToBytea` — the hex codec for a `bytea` value without the Node `Buffer` global; `hexToBytea` **throws `TypeError`** on a malformed input, where `Buffer.from` would silently truncate it.

```ts
export const jsonbSchema: <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S) => (name: string) => PgCustomColumnBuilder<…>;
export const tsvector: (name: string) => PgCustomColumnBuilder<…>;
export const bytea: (name: string) => PgCustomColumnBuilder<…>;
export const timestamps: () => { readonly createdAt: …; readonly updatedAt: … };
export const byteaToHex: (bytes: Uint8Array) => string;
export const hexToBytea: (hex: string) => Uint8Array;
```
