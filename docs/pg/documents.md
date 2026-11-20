# `./Documents`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

A content-addressed document store. A document is stored once, keyed by the SHA-256 Postgres derives from its canonical `jsonb` text, and **never rewritten**. Entities point at documents by hash, so equal documents are shared and a version that didn't change a document doesn't copy it.

## The table

```ts
import { documentColumns } from "@thomasfosterau/effect-drizzle-ext-pg/Documents";

export const documentTable = pgTable("document", documentColumns());
```

| Column | Meaning |
| --- | --- |
| `hash` | `bytea`, the primary key, generated: `digest(document::text, 'sha256')`. Needs `pgcrypto` (declare it with `./tooling`'s `extension("pgcrypto")`). |
| `document` | `jsonb`. |

Because the hash is the database's own digest of `jsonb`'s canonical text, two documents that differ only in key order or whitespace are the same document.

## Operations

`makeDocumentStore({ table, document, CurrentTransaction })` returns three operations. Each requires `CurrentTransaction` and none opens a transaction. `document` is the documents' schema: `put` encodes through it, and a stored document that doesn't decode is a defect.

| Operation | What it does |
| --- | --- |
| `put(document)` | `INSERT … ON CONFLICT DO NOTHING RETURNING`. Answers `{ hash, inserted }`; an already-stored document writes nothing and answers its hash with `inserted: false`. |
| `get(hash)` | The document, if stored. |
| `getMany(hashes)` | The stored documents among `hashes`, in one read, as a `HashMap` by hash. |

A hash is a `DocumentHash`: 64 lowercase hex characters. A string that isn't one names no document and sends no query.
