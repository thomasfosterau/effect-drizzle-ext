# `./ExternalIds`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

A node's identifiers at outside authorities (a Wikidata QID, an ISBN, a feed's own key) in one identity-level table, and the reads and writes an import resolves against.

## The table

```ts
import { makeExternalIdTable } from "@thomasfosterau/effect-drizzle-ext-pg/ExternalIds";

export const externalIds = makeExternalIdTable({ identity: tables.root.identity, schema: kb });

// With columns of your own:
export const authorityIds = kb.table(
  "authority_id",
  { ...externalIdColumns(tables.root.identity.id), baseline: jsonb("baseline") },
  externalIdConstraints("authority_id"),
);
```

| Column or key | Meaning |
| --- | --- |
| `authority`, `external_id` | The primary key (`${name}_pkey`): one node per id at an authority. |
| `node_id` | References the identity row, deleted with it. |
| `${name}_node` | Unique `(node_id, authority)`: one id per authority per node. It also serves a node's links. |

`makeExternalIdTable` names the table `external_id` unless told otherwise.

## Operations

`makeExternalIdStore({ table, CurrentTransaction })` returns three operations, each in the caller's transaction.

| Operation | What it does |
| --- | --- |
| `lookup(authority, externalIds)` | The nodes those ids name, as a `HashMap` by external id. More than `MAX_LOOKUP` (1000) ids read nothing. |
| `linksOf(nodeId)` | Every link of a node, by authority. An id that isn't a UUID has none. |
| `link({ authority, externalId, nodeId })` | Never moves a link. Answers `linked`, `present` (the same link was there) or `taken` (another node has the id). A node already linked at the authority under another id is the driver's unique violation on `${name}_node`. |
