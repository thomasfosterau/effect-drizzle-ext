/**
 * The interpreter behind `defineTree` (`.`) and `defineResourceTree`
 * (`./jsonapi`): one Drizzle-free declaration of an ontology's level tree, from
 * which every structural fact the database layer needs is derived at module
 * load. Not a published subpath: the two entries re-export its types and wrap
 * {@link buildTree} with their own leaf reader.
 *
 * **Shape.** A tree is an ordered record of levels. Each level names its
 * `parent` (another level; absent means a child of the root, i.e. a branch
 * root), may carry level `columns` (`dbColumn`-annotated fields contributed to
 * every descendant's view, landing on that level's version table) and a level
 * `kind`, and is either a **marker** (no `leaf`) or a **leaf** (a `leaf`
 * payload: a struct's fields in `.`, a `Resource.make` definition in
 * `./jsonapi`). A leaf's name is its discriminator value.
 *
 * **Order.** Declaration order is preserved wherever it becomes SQL order: the
 * level list, every descendant and subtree-leaf list (the discriminator CHECK
 * value sets), and each level's columns.
 *
 * **Failures.** Every check throws {@link DerivationError} at module load:
 * there is no runtime yet, and a misdeclared tree must stop its `import`.
 *
 * @module tree
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import type * as Schema from "effect/Schema";
import { DerivationError } from "./derivation-error.ts";
import type { DbColumn } from "./index.ts";

/**
 * How a level stores its columns. `"plain"` (the default): one version table
 * carrying every level column. `"fact-scoped"`: an `(id, version)` spine plus
 * one fact table per level column, where a fact's absence at a version is its
 * `NULL` (website's 6NF `manifestation_version` pilot).
 */
export type LevelKind = "plain" | "fact-scoped";

/* oxlint-disable effect/prefer-option-over-null -- a declaration literal threaded into the table derivation, like DbColumn: every member is read once at module load and converted to `Option` on the derived TreeLevel */
/**
 * One level's declaration, generic in the names its `parent` may take and in
 * the leaf payload. Optional members are `?: T | undefined` so a caller can
 * forward its own optional.
 */
export interface LevelSpec<Parent extends string = string, Leaf = unknown> {
  /** The parent level. Absent: a child of the root (a branch root). */
  readonly parent?: Parent | undefined;
  /** How the level stores its columns; `"plain"` when absent. */
  readonly kind?: LevelKind | undefined;
  /**
   * Level columns: `dbColumn`-annotated fields on this level's version table,
   * contributed to every descendant's view. Every field must carry a
   * `dbColumn` annotation.
   */
  readonly columns?: Schema.Struct.Fields | undefined;
  /** The leaf payload. Present: a concrete leaf; absent: a marker level. */
  readonly leaf?: Leaf | undefined;
}
/* oxlint-enable effect/prefer-option-over-null */

/**
 * The constraint a tree declaration `S` is checked against: every entry is a
 * {@link LevelSpec} whose `parent` names **another** level of `S`, plus the
 * consumer's extension record `Ext` (pulpit's `owned` / `pageable` flags, say),
 * whose names the library never learns. A parent naming no level, or the level
 * itself, is a type error at the declaration.
 */
export type CheckedTreeSpec<S, Leaf, Ext> = {
  readonly [K in keyof S]: LevelSpec<Exclude<keyof S & string, K>, Leaf> & Ext;
};

/** Every level name a tree declaration `S` declares (a `Tree` reads its own). */
export type LevelName<S> = keyof S & string;

/** The names of the leaf levels of declaration `S`: the discriminator values. */
export type LeafName<S> = {
  readonly [K in keyof S]: S[K] extends { readonly leaf?: infer L }
    ? [Exclude<L, undefined>] extends [never]
      ? never
      : K
    : never;
}[keyof S] &
  string;

/** The names of the marker (non-leaf) levels of declaration `S`. */
export type MarkerName<S> = Exclude<LevelName<S>, LeafName<S>>;

/** Everything derived about one level of a tree. */
export interface TreeLevel<S> {
  /** The level's name (a leaf's discriminator value). */
  readonly name: LevelName<S>;
  /** The declaration entry, extension flags included. */
  readonly entry: S[LevelName<S>];
  /** The parent level; `Option.none()` for a branch root. */
  readonly parent: Option.Option<LevelName<S>>;
  /** The level kind, `"plain"` when the entry names none. */
  readonly kind: LevelKind;
  /** Whether the level is a concrete leaf. */
  readonly isLeaf: boolean;
  /** Every ancestor, root-most first, the level itself excluded. */
  readonly ancestors: ReadonlyArray<LevelName<S>>;
  /** The direct children, in declaration order. */
  readonly children: ReadonlyArray<LevelName<S>>;
  /** Every descendant, in declaration order, the level itself excluded. */
  readonly descendants: ReadonlyArray<LevelName<S>>;
  /**
   * The leaves of the level's subtree in declaration order, the level itself
   * included when it is a leaf: the value set of its discriminator CHECK.
   */
  readonly subtreeLeaves: ReadonlyArray<LeafName<S>>;
  /** The branch root the level belongs to (itself for a branch root). */
  readonly branch: LevelName<S>;
  /** The level columns' db-column metadata, keyed by field, in order. */
  readonly levelColumns: Readonly<Record<string, DbColumn>>;
  /** A leaf's own domain columns, keyed by field, in order; empty for a marker. */
  readonly leafColumns: Readonly<Record<string, DbColumn>>;
}

/** A checked tree: the declaration plus every level's derived facts. */
export interface Tree<S> {
  /** The declaration exactly as written, for type-level consumers. */
  readonly spec: S;
  /** Every level name, in declaration order. */
  readonly names: ReadonlyArray<LevelName<S>>;
  /** Every level, in declaration order. */
  readonly levels: ReadonlyArray<TreeLevel<S>>;
  /** The leaf names, in declaration order. */
  readonly leaves: ReadonlyArray<LeafName<S>>;
  /** The branch roots (children of the root), in declaration order. */
  readonly branchRoots: ReadonlyArray<LevelName<S>>;
  /** Look a level up by name. */
  readonly level: (name: LevelName<S>) => TreeLevel<S>;
}

/**
 * How an entry reads its columns: `levelColumns` maps a level's `columns`
 * fields to their db-column metadata (dropping unannotated fields), and
 * `leafColumns` does the same for a leaf payload, throwing
 * {@link DerivationError} for a payload that doesn't fit its level (a resource
 * whose `type` isn't the level's name).
 */
export interface TreeReader<Leaf> {
  readonly levelColumns: (fields: Schema.Struct.Fields) => Readonly<Record<string, DbColumn>>;
  readonly leafColumns: (leaf: Leaf, name: string) => Readonly<Record<string, DbColumn>>;
}

/**
 * Names no level column or leaf column may take: the chain's own columns, which
 * the derived tables and views project from the root and from every level.
 */
const RESERVED_COLUMN_NAMES: ReadonlyArray<string> = ["id", "version", "action", "type"];

/** Throw the tree's {@link DerivationError}. */
export const treeError = (message: string): never => {
  throw new DerivationError({ message: `defineTree: ${message}` });
};

/** Throw for a level whose `parent` names no level of the tree. */
const unknownParent = (name: string, parent: string): never =>
  treeError(`level "${name}" names parent "${parent}", which is not a level of this tree`);

/** A canonical array index, which a JS object would reorder ahead of declaration order. */
const isArrayIndex = (name: string): boolean => /^(?:0|[1-9]\d*)$/.test(name);

/** One column a level contributes to every root-to-leaf path through it. */
interface PathColumn {
  readonly level: string;
  readonly key: string;
  readonly column: string;
}

/** The first column on a path whose key or column name an earlier one took. */
const firstClash = (
  path: ReadonlyArray<PathColumn>,
): Option.Option<readonly [PathColumn, PathColumn]> =>
  Arr.findFirst(
    Arr.map(path, (later, i) =>
      Option.map(
        Arr.findFirst(
          Arr.take(path, i),
          (earlier) => earlier.key === later.key || earlier.column === later.column,
        ),
        (earlier) => [earlier, later] as const,
      ),
    ),
    Option.isSome,
  ).pipe(Option.flatten);

/**
 * Check a tree declaration and derive every level's facts. Throws
 * {@link DerivationError} at module load for an empty tree, a level name a JS
 * object would reorder (an array index) or that is empty, a parent naming no
 * level, a parent cycle, a leaf with children, a marker with no leaf below it,
 * a level column without a `dbColumn` annotation, a column taking a reserved
 * name (`id`, `version`, `action`, `type`), or two columns on one root-to-leaf
 * path sharing a field key or a column name. The entries' own payload checks
 * come from `reader`.
 */
export const buildTree = <S extends Readonly<Record<string, LevelSpec<string, Leaf>>>, Leaf>(
  spec: S,
  reader: TreeReader<Leaf>,
): Tree<S> => {
  const names: ReadonlyArray<LevelName<S>> = R.keys(spec);
  if (!Arr.isReadonlyArrayNonEmpty(names)) treeError("a tree needs at least one level");
  Arr.forEach(names, (name) => {
    if (name === "" || isArrayIndex(name)) {
      treeError(
        `level name "${name}" is not allowed: an empty name or an array index would not keep declaration order`,
      );
    }
  });

  const has = (name: string): name is LevelName<S> => R.has(spec, name);
  const entryOf = (name: LevelName<S>): S[LevelName<S>] => spec[name];
  const parentOf = (name: LevelName<S>): Option.Option<LevelName<S>> =>
    Option.map(Option.fromUndefinedOr(entryOf(name).parent), (parent: string) =>
      has(parent) ? parent : unknownParent(name, parent),
    );
  const leafOf = (name: LevelName<S>): Option.Option<Leaf> =>
    Option.fromUndefinedOr(entryOf(name).leaf);
  const isLeafName = (name: LevelName<S>): name is LeafName<S> => Option.isSome(leafOf(name));

  // Root-most first; `trail` is the chain walked so far, so a parent already on
  // it closes a cycle.
  const ancestorsOf = (
    name: LevelName<S>,
    trail: ReadonlyArray<LevelName<S>>,
  ): ReadonlyArray<LevelName<S>> =>
    Option.match(parentOf(name), {
      onNone: () => [],
      onSome: (parent) =>
        Arr.contains(trail, parent)
          ? treeError(
              `the parents form a cycle: ${[...Arr.dropWhile(trail, (step) => step !== parent), parent].join(" → ")}`,
            )
          : [...ancestorsOf(parent, [...trail, parent]), parent],
    });
  const ancestorsFor = (name: LevelName<S>): ReadonlyArray<LevelName<S>> =>
    ancestorsOf(name, [name]);

  const leaves = Arr.filter(names, isLeafName);
  const childrenOf = (name: LevelName<S>): ReadonlyArray<LevelName<S>> =>
    Arr.filter(names, (candidate) =>
      Option.exists(parentOf(candidate), (parent) => parent === name),
    );
  const descendantsOf = (name: LevelName<S>): ReadonlyArray<LevelName<S>> =>
    Arr.filter(names, (candidate) => Arr.contains(ancestorsFor(candidate), name));
  const subtreeLeavesOf = (name: LevelName<S>): ReadonlyArray<LeafName<S>> =>
    Arr.filter(leaves, (leaf) => leaf === name || Arr.contains(ancestorsFor(leaf), name));

  Arr.forEach(names, (name) => {
    if (isLeafName(name) && Arr.isReadonlyArrayNonEmpty(childrenOf(name))) {
      treeError(
        `leaf "${name}" has children (${childrenOf(name).join(", ")}); only a marker level can be a parent`,
      );
    }
    if (!isLeafName(name) && !Arr.isReadonlyArrayNonEmpty(subtreeLeavesOf(name))) {
      treeError(
        `marker level "${name}" has no leaf below it, so its discriminator CHECK would admit nothing`,
      );
    }
  });

  const levelColumnsOf = (name: LevelName<S>): Readonly<Record<string, DbColumn>> => {
    const fields = entryOf(name).columns ?? {};
    const columns = reader.levelColumns(fields);
    const bare = Arr.filter(R.keys(fields), (key) => !R.has(columns, key));
    return Arr.isReadonlyArrayNonEmpty(bare)
      ? treeError(
          `level "${name}" declares level columns with no dbColumn annotation (${bare.join(", ")}); a level column must back a database column`,
        )
      : columns;
  };
  const leafColumnsOf = (name: LevelName<S>): Readonly<Record<string, DbColumn>> =>
    Option.match(leafOf(name), {
      onNone: () => ({}),
      onSome: (leaf) => reader.leafColumns(leaf, name),
    });
  const ownColumnsFor = (name: LevelName<S>) => {
    const levelColumns = levelColumnsOf(name);
    const leafColumns = leafColumnsOf(name);
    const path: ReadonlyArray<PathColumn> = Arr.map(
      [...R.toEntries(levelColumns), ...R.toEntries(leafColumns)],
      ([key, meta]) => ({ level: name, key, column: meta.column }),
    );
    Arr.forEach(path, ({ key, column }) => {
      if (Arr.contains(RESERVED_COLUMN_NAMES, key) || Arr.contains(RESERVED_COLUMN_NAMES, column)) {
        treeError(
          `level "${name}" declares "${key}" (column "${column}"), but ${RESERVED_COLUMN_NAMES.join(", ")} are reserved for the chain`,
        );
      }
    });
    return { levelColumns, leafColumns, path };
  };
  // Read and check every level's own columns once, in declaration order,
  // before any path is compared.
  const ownColumns = Arr.map(names, (name) => ({ name, ...ownColumnsFor(name) }));
  const ownOf = (name: LevelName<S>) =>
    Option.getOrElse(
      Arr.findFirst(ownColumns, (own) => own.name === name),
      () => ({ name, levelColumns: {}, leafColumns: {}, path: [] }),
    );

  // Every view joins a leaf's whole root-to-leaf path, so a key or column name
  // may appear once per path; siblings may reuse one.
  Arr.forEach(leaves, (leaf) => {
    const path = Arr.flatMap([...ancestorsFor(leaf), leaf], (name) => ownOf(name).path);
    Option.map(firstClash(path), ([earlier, later]) =>
      treeError(
        `"${later.key}" (column "${later.column}") on level "${later.level}" collides with "${earlier.key}" (column "${earlier.column}") on level "${earlier.level}"; both reach leaf "${leaf}"`,
      ),
    );
  });

  const levels = Arr.map(names, (name): TreeLevel<S> => ({
    name,
    entry: entryOf(name),
    parent: parentOf(name),
    kind: entryOf(name).kind ?? "plain",
    isLeaf: isLeafName(name),
    ancestors: ancestorsFor(name),
    children: childrenOf(name),
    descendants: descendantsOf(name),
    subtreeLeaves: subtreeLeavesOf(name),
    branch: Option.getOrElse(Arr.head(ancestorsFor(name)), () => name),
    levelColumns: ownOf(name).levelColumns,
    leafColumns: ownOf(name).leafColumns,
  }));
  return {
    spec,
    names,
    levels,
    leaves,
    branchRoots: Arr.filter(names, (name) => Option.isNone(parentOf(name))),
    level: (name) =>
      Option.getOrElse(
        Arr.findFirst(levels, (level) => level.name === name),
        () => treeError(`"${name}" is not a level of this tree`),
      ),
  };
};
