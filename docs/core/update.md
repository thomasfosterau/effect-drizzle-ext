# `./update`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

The update tri-state at a single seam. An update input encodes three states across key presence and value — a value **sets**, a present `null` **clears** (a nullable column), an absent key or explicit `undefined` **carries the stored value forward**. `updateSetMap(input, writable)` builds the `UPDATE … SET` map from the input's own keys: every key in `writable` with a present value (`null` included), in the input's key order. The routing `id`, server-owned columns and unknown keys drop out, and so does an `undefined` value, so a carry-forward can never become a clear. `insertValues` is the same projection for a create: an absent optional is left to the column default.

Nothing here is `Option`: the `null` / `undefined` split _is_ the tri-state, and the map is Drizzle-facing.

```ts
export type UpdateSet<I, K extends string> = {
  readonly [P in Extract<keyof I, K>]?: Exclude<I[P], undefined>;
};
export const updateSetMap: <I extends Readonly<Record<string, unknown>>, K extends string>(
  input: I,
  writable: Iterable<K>,
) => UpdateSet<I, K>;
export const insertValues: typeof updateSetMap;
```

```ts
const WRITABLE = HashSet.make("name", "summary", "birthPlaceId");
yield * tx.update(person).set(updateSetMap(input, WRITABLE)).where(eq(person.id, input.id));
```
