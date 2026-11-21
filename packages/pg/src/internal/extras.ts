/**
 * Migrations for what drizzle-kit doesn't manage (extensions, domains,
 * composite types): `generateExtrasMigration` and the `checkExtrasDrift` gate.
 * See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/tooling.md).
 *
 * @module internal/extras
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

/** The file, inside a migration directory, that records the extras state after that migration. */
export const EXTRAS_STATE_FILE = "extras.json";

const BREAKPOINT = "\n--> statement-breakpoint\n";

// ── Declarations ────────────────────────────────────────────────────────

/** An extension, as declared and as recorded. Extensions are database-wide, so `name` is the key. */
export const Extension = Schema.Struct({
  name: Schema.String,
  schema: Schema.String,
  version: Schema.OptionFromOptionalKey(Schema.String),
});

/** An extension, as {@link extension} returns it. */
export type Extension = typeof Extension.Type;

/** A domain, as declared and as recorded; `schema` + `name` is the key. */
export const Domain = Schema.Struct({
  schema: Schema.String,
  name: Schema.String,
  type: Schema.String,
  isNotNull: Schema.Boolean,
  default: Schema.OptionFromOptionalKey(Schema.String),
  checks: Schema.Array(Schema.Struct({ name: Schema.String, expression: Schema.String })),
});

/** A domain, as {@link domain} returns it. */
export type Domain = typeof Domain.Type;

/** A composite type, as declared and as recorded; `schema` + `name` is the key. */
export const CompositeType = Schema.Struct({
  schema: Schema.String,
  name: Schema.String,
  attributes: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })),
});

/** A composite type, as {@link compositeType} returns it. */
export type CompositeType = typeof CompositeType.Type;

/** The extras an application declares; each list is in creation order. */
export interface Extras {
  readonly extensions?: ReadonlyArray<Extension>;
  readonly domains?: ReadonlyArray<Domain>;
  readonly compositeTypes?: ReadonlyArray<CompositeType>;
}

/** The options {@link extension} takes. */
export interface ExtensionOptions {
  /** The schema the extension's objects are created in; `public` when absent. */
  readonly schema?: string;
  /** The version to install, or to `ALTER EXTENSION … UPDATE TO`; the default version when absent. */
  readonly version?: string;
}

/**
 * Declare an extension (`CREATE EXTENSION IF NOT EXISTS`).
 *
 * @example
 * ```ts
 * import { extension } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
 *
 * export const vector = extension("vector", { version: "0.8.0" });
 * export const trigram = extension("pg_trgm", { schema: "extensions" });
 * ```
 */
export const extension = (name: string, options?: ExtensionOptions): Extension => ({
  name,
  schema: options?.schema ?? "public",
  version: Option.fromUndefinedOr(options?.version),
});

/** The options {@link domain} takes. */
export interface DomainOptions {
  /** The domain's schema; `public` when absent. */
  readonly schema?: string;
  /** `NOT NULL`; false when absent. */
  readonly notNull?: boolean;
  /** The default, as an SQL expression. */
  readonly default?: string;
  /** Named `CHECK` constraints, as SQL expressions over `VALUE`, in creation order. */
  readonly checks?: Readonly<Record<string, string>>;
}

/**
 * Declare a domain (`CREATE DOMAIN … AS <type>`); `type` is SQL, emitted as written.
 *
 * @example
 * ```ts
 * import { domain } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
 *
 * export const email = domain("email", "text", {
 *   notNull: true,
 *   checks: { email_has_at: "position('@' in VALUE) > 1" },
 * });
 * ```
 */
export const domain = (name: string, type: string, options?: DomainOptions): Domain => ({
  schema: options?.schema ?? "public",
  name,
  type,
  isNotNull: options?.notNull ?? false,
  default: Option.fromUndefinedOr(options?.default),
  checks: Arr.map(R.toEntries(options?.checks ?? {}), ([checkName, expression]) => ({
    name: checkName,
    expression,
  })),
});

/** The options {@link compositeType} takes. */
export interface CompositeTypeOptions {
  /** The type's schema; `public` when absent. */
  readonly schema?: string;
}

/**
 * Declare a composite type (`CREATE TYPE … AS (…)`); each attribute's type is
 * SQL, emitted as written, in the record's order.
 *
 * @example
 * ```ts
 * import { compositeType } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
 *
 * export const money = compositeType("money_amount", { amount: "numeric(12, 2)", currency: "char(3)" });
 * ```
 */
export const compositeType = (
  name: string,
  attributes: Readonly<Record<string, string>>,
  options?: CompositeTypeOptions,
): CompositeType => ({
  schema: options?.schema ?? "public",
  name,
  attributes: Arr.map(R.toEntries(attributes), ([attribute, type]) => ({
    name: attribute,
    type,
  })),
});

// ── State ───────────────────────────────────────────────────────────────

/** The extras state {@link EXTRAS_STATE_FILE} records: every declared object, in declaration order. */
export const ExtrasState = Schema.Struct({
  version: Schema.Literal(1),
  extensions: Schema.Array(Extension),
  domains: Schema.Array(Domain),
  compositeTypes: Schema.Array(CompositeType),
});

/** The extras state, as {@link ExtrasState} decodes it. */
export type ExtrasState = typeof ExtrasState.Type;

const ExtrasStateJson = Schema.fromJsonString(ExtrasState);

/** The state before the first extras migration: nothing recorded. */
export const emptyExtrasState: ExtrasState = {
  version: 1,
  extensions: [],
  domains: [],
  compositeTypes: [],
};

/** The declared extras as the state a migration records. */
export const toExtrasState = (extras: Extras): ExtrasState => ({
  version: 1,
  extensions: extras.extensions ?? [],
  domains: extras.domains ?? [],
  compositeTypes: extras.compositeTypes ?? [],
});

/** An {@link EXTRAS_STATE_FILE} could not be decoded; `file` is its path. */
export class MalformedExtrasState extends Schema.TaggedError<MalformedExtrasState>()(
  "MalformedExtrasState",
  { file: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.file} is not an extras state file (malformed JSON or an unknown shape); never hand-edit it.`;
  }
}

/** The recorded state: where it was read from, and what it holds. */
export interface RecordedExtras {
  /** The migration directory whose {@link EXTRAS_STATE_FILE} holds it; none before the first extras migration. */
  readonly dir: Option.Option<string>;
  readonly state: ExtrasState;
}

/**
 * The extras state recorded under `migrationsDir`: the {@link EXTRAS_STATE_FILE}
 * of the latest-by-name migration directory that has one, or
 * {@link emptyExtrasState} when none does. A file that doesn't decode fails
 * with {@link MalformedExtrasState}.
 */
export const readExtrasState = Effect.fn("Tooling.readExtrasState")(function* (
  migrationsDir: string,
): Effect.fn.Return<
  RecordedExtras,
  MalformedExtrasState | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = Arr.sort(yield* fs.readDirectory(migrationsDir), Order.String).toReversed();
  const dir = yield* Effect.findFirst(names, (name) =>
    fs.exists(path.join(migrationsDir, name, EXTRAS_STATE_FILE)),
  );
  if (Option.isNone(dir)) return { dir, state: emptyExtrasState };
  const file = path.join(migrationsDir, dir.value, EXTRAS_STATE_FILE);
  const state = yield* Schema.decodeEffect(ExtrasStateJson)(yield* fs.readFileString(file)).pipe(
    Effect.mapError((cause) => new MalformedExtrasState({ file, cause })),
  );
  return { dir, state };
});

// ── The plan (pure) ─────────────────────────────────────────────────────

/**
 * The declared extras can't be planned; `issues` holds one report per
 * problem (a duplicate declaration, or a change Postgres can't `ALTER`).
 */
export class ExtrasError extends Schema.TaggedError<ExtrasError>()("ExtrasError", {
  issues: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `The extras can't be migrated (${this.issues.length} issue(s)):\n\n${this.issues.join("\n\n")}`;
  }
}

/** The SQL that moves the recorded state to the declared one, or why it can't. */
export interface ExtrasPlan {
  /** One statement each, `;`-terminated, in apply order. */
  readonly statements: ReadonlyArray<string>;
  /** Problems that block the plan; non-empty means `statements` must not be applied. */
  readonly issues: ReadonlyArray<string>;
}

/** A quoted SQL identifier. */
const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A quoted SQL string literal. */
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const qualified = (object: { readonly schema: string; readonly name: string }): string =>
  `${ident(object.schema)}.${ident(object.name)}`;

const label = (object: { readonly schema: string; readonly name: string }): string =>
  `${object.schema}.${object.name}`;

/** The keys that occur more than once, each reported once. */
const repeatedKeys = <A>(
  items: ReadonlyArray<A>,
  key: (item: A) => string,
): ReadonlyArray<string> =>
  R.keys(
    R.filter(
      Arr.reduce(items, R.empty<string, number>(), (acc, item) =>
        R.set(acc, key(item), (acc[key(item)] ?? 0) + 1),
      ),
      (count) => count > 1,
    ),
  );

const duplicates = <A>(
  kind: string,
  items: ReadonlyArray<A>,
  key: (item: A) => string,
): ReadonlyArray<string> =>
  Arr.map(repeatedKeys(items, key), (name) => `${kind} '${name}' is declared more than once.`);

const extensionKey = (each: Extension): string => each.name;

const createExtension = (each: Extension): string =>
  `CREATE EXTENSION IF NOT EXISTS ${ident(each.name)} WITH SCHEMA ${ident(each.schema)}` +
  Option.match(each.version, { onNone: () => "", onSome: (v) => ` VERSION ${literal(v)}` }) +
  ";";

const alterExtension = (prev: Extension, next: Extension): ReadonlyArray<string> => [
  ...(prev.schema === next.schema
    ? []
    : [`ALTER EXTENSION ${ident(next.name)} SET SCHEMA ${ident(next.schema)};`]),
  // Un-pinning a version changes nothing installed; only a new pin updates.
  ...Option.match(next.version, {
    onNone: () => [],
    onSome: (version) =>
      Eq.equals(prev.version, next.version)
        ? []
        : [`ALTER EXTENSION ${ident(next.name)} UPDATE TO ${literal(version)};`],
  }),
];

const createDomain = (each: Domain): string =>
  `CREATE DOMAIN ${qualified(each)} AS ${each.type}` +
  Option.match(each.default, { onNone: () => "", onSome: (d) => ` DEFAULT ${d}` }) +
  (each.isNotNull ? " NOT NULL" : "") +
  each.checks
    .map((check) => ` CONSTRAINT ${ident(check.name)} CHECK (${check.expression})`)
    .join("") +
  ";";

const alterDomain = (prev: Domain, next: Domain): ExtrasPlan => {
  if (prev.type !== next.type) {
    return {
      statements: [],
      issues: [
        `domain '${label(next)}' changes its base type from \`${prev.type}\` to \`${next.type}\`, ` +
          "which Postgres can't ALTER. Declare a new domain, move the columns to it, then remove the old one; " +
          "or write the change by hand in a recordOnly migration.",
      ],
    };
  }
  const target = `ALTER DOMAIN ${qualified(next)}`;
  const nextChecks = R.fromEntries(Arr.map(next.checks, (c) => [c.name, c.expression]));
  const prevChecks = R.fromEntries(Arr.map(prev.checks, (c) => [c.name, c.expression]));
  const dropped = prev.checks.filter((c) => nextChecks[c.name] !== c.expression);
  const added = next.checks.filter((c) => prevChecks[c.name] !== c.expression);
  return {
    statements: [
      ...(Eq.equals(prev.default, next.default)
        ? []
        : [
            Option.match(next.default, {
              onNone: () => `${target} DROP DEFAULT;`,
              onSome: (d) => `${target} SET DEFAULT ${d};`,
            }),
          ]),
      ...(prev.isNotNull === next.isNotNull
        ? []
        : [`${target} ${next.isNotNull ? "SET" : "DROP"} NOT NULL;`]),
      ...dropped.map((c) => `${target} DROP CONSTRAINT ${ident(c.name)};`),
      ...added.map((c) => `${target} ADD CONSTRAINT ${ident(c.name)} CHECK (${c.expression});`),
    ],
    issues: [],
  };
};

const createCompositeType = (each: CompositeType): string =>
  `CREATE TYPE ${qualified(each)} AS (` +
  each.attributes.map((a) => `${ident(a.name)} ${a.type}`).join(", ") +
  ");";

const alterCompositeType = (prev: CompositeType, next: CompositeType): ReadonlyArray<string> => {
  const target = `ALTER TYPE ${qualified(next)}`;
  const nextTypes = R.fromEntries(Arr.map(next.attributes, (a) => [a.name, a.type]));
  const prevTypes = R.fromEntries(Arr.map(prev.attributes, (a) => [a.name, a.type]));
  return [
    ...prev.attributes
      .filter((a) => !R.has(nextTypes, a.name))
      .map((a) => `${target} DROP ATTRIBUTE ${ident(a.name)};`),
    ...next.attributes.flatMap((a) =>
      Option.match(R.get(prevTypes, a.name), {
        onNone: () => [`${target} ADD ATTRIBUTE ${ident(a.name)} ${a.type};`],
        onSome: (type) =>
          type === a.type ? [] : [`${target} ALTER ATTRIBUTE ${ident(a.name)} TYPE ${a.type};`],
      }),
    ),
  ];
};

/** One kind's creates and alters (in declared order) and drops (in reverse recorded order). */
interface KindPlan {
  readonly upserts: ExtrasPlan;
  readonly drops: ReadonlyArray<string>;
}

const planKind = <A>(
  prev: ReadonlyArray<A>,
  next: ReadonlyArray<A>,
  key: (item: A) => string,
  create: (item: A) => string,
  alter: (prev: A, next: A) => ExtrasPlan,
  drop: (item: A) => string,
): KindPlan => {
  const recorded = R.fromEntries(Arr.map(prev, (item) => [key(item), item]));
  const declared = R.fromEntries(Arr.map(next, (item) => [key(item), item]));
  const upserts = next.map((item) =>
    Option.match(R.get(recorded, key(item)), {
      onNone: (): ExtrasPlan => ({ statements: [create(item)], issues: [] }),
      onSome: (before) => alter(before, item),
    }),
  );
  return {
    upserts: {
      statements: upserts.flatMap((plan) => plan.statements),
      issues: upserts.flatMap((plan) => plan.issues),
    },
    drops: prev
      .filter((item) => !R.has(declared, key(item)))
      .toReversed()
      .map(drop),
  };
};

const statementsOnly =
  <A>(alter: (prev: A, next: A) => ReadonlyArray<string>) =>
  (prev: A, next: A): ExtrasPlan => ({ statements: alter(prev, next), issues: [] });

// ── Rename hints ────────────────────────────────────────────────────────

/**
 * A rename the generator can't infer, the way drizzle-kit's prompt resolves
 * rename-or-recreate. A domain or composite type is named `schema.name`, or
 * bare `name` for `public`; an attribute hint names its type by its new name.
 */
export type ExtrasRename =
  | readonly [kind: "domain" | "compositeType", from: string, to: string]
  | readonly [kind: "attribute", type: string, from: string, to: string];

interface Named {
  readonly schema: string;
  readonly name: string;
}

/** A hint's object name as a {@link label}: bare names are in `public`. */
const labelOf = (name: string): string => (name.includes(".") ? name : `public.${name}`);

/** The recorded objects of one kind renamed to their declared names, and the SQL that renames them. */
interface Renamed<A> {
  readonly items: ReadonlyArray<A>;
  readonly statements: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<string>;
}

/** The reports of the checks that failed, each given as `[failed, report]`. */
const failing = (checks: ReadonlyArray<readonly [boolean, string]>): ReadonlyArray<string> =>
  Arr.map(
    Arr.filter(checks, ([failed]) => failed),
    ([, report]) => report,
  );

const renameObjects = <A extends Named>(
  kind: "domain" | "composite type",
  keyword: "DOMAIN" | "TYPE",
  prev: ReadonlyArray<A>,
  next: ReadonlyArray<A>,
  hints: ReadonlyArray<readonly [from: string, to: string]>,
): Renamed<A> => {
  const recorded = R.fromEntries(Arr.map(prev, (item) => [label(item), item]));
  const declared = R.fromEntries(Arr.map(next, (item) => [label(item), item]));
  const pairs = Arr.map(hints, ([from, to]) => [labelOf(from), labelOf(to)] as const);
  const issues = [
    ...Arr.map(
      repeatedKeys(pairs, ([from]) => from),
      (from) => `${kind} '${from}' has more than one rename hint.`,
    ),
    ...Arr.map(
      repeatedKeys(pairs, ([, to]) => to),
      (to) => `more than one rename hint targets ${kind} '${to}'.`,
    ),
    ...pairs.flatMap(([from, to]) =>
      failing([
        [!R.has(recorded, from), `rename hint ${from} → ${to}: no ${kind} '${from}' is recorded.`],
        [!R.has(declared, to), `rename hint ${from} → ${to}: no ${kind} '${to}' is declared.`],
        [
          R.has(declared, from),
          `rename hint ${from} → ${to}: ${kind} '${from}' is still declared.`,
        ],
        [R.has(recorded, to), `rename hint ${from} → ${to}: ${kind} '${to}' is already recorded.`],
      ]),
    ),
  ];
  if (Arr.isReadonlyArrayNonEmpty(issues)) return { items: prev, statements: [], issues };
  const resolved = pairs.flatMap(([from, to]) =>
    Arr.fromOption(Option.all([R.get(recorded, from), R.get(declared, to)] as const)),
  );
  return {
    items: Arr.map(prev, (item) =>
      Option.match(
        Arr.findFirst(resolved, ([before]) => before === item),
        {
          onNone: () => item,
          onSome: ([, after]) => ({ ...item, schema: after.schema, name: after.name }),
        },
      ),
    ),
    statements: resolved.flatMap(([before, after]) =>
      Arr.filter(
        [
          before.name === after.name
            ? ""
            : `ALTER ${keyword} ${qualified(before)} RENAME TO ${ident(after.name)};`,
          before.schema === after.schema
            ? ""
            : `ALTER ${keyword} ${qualified({ schema: before.schema, name: after.name })} SET SCHEMA ${ident(after.schema)};`,
        ],
        Str.isNonEmpty,
      ),
    ),
    issues: [],
  };
};

const renameAttributes = (
  prev: ReadonlyArray<CompositeType>,
  next: ReadonlyArray<CompositeType>,
  hints: ReadonlyArray<readonly [type: string, from: string, to: string]>,
): Renamed<CompositeType> => {
  const recorded = R.fromEntries(Arr.map(prev, (item) => [label(item), item]));
  const declared = R.fromEntries(Arr.map(next, (item) => [label(item), item]));
  const triples = Arr.map(hints, ([type, from, to]) => [labelOf(type), from, to] as const);
  const has = (
    types: Readonly<Record<string, CompositeType>>,
    type: string,
    attribute: string,
  ): boolean =>
    Option.match(R.get(types, type), {
      onNone: () => false,
      onSome: (each) => Arr.some(each.attributes, (a) => a.name === attribute),
    });
  const issues = [
    ...Arr.map(
      repeatedKeys(triples, ([type, from]) => `${type}.${from}`),
      (attribute) => `attribute '${attribute}' has more than one rename hint.`,
    ),
    ...triples.flatMap(([type, from, to]) => {
      const hint = `rename hint ${type}.${from} → ${to}`;
      if (!R.has(recorded, type) || !R.has(declared, type)) {
        return [`${hint}: composite type '${type}' must be both recorded and declared.`];
      }
      return failing([
        [!has(recorded, type, from), `${hint}: no attribute '${from}' is recorded.`],
        [!has(declared, type, to), `${hint}: no attribute '${to}' is declared.`],
        [has(declared, type, from), `${hint}: attribute '${from}' is still declared.`],
        [has(recorded, type, to), `${hint}: attribute '${to}' is already recorded.`],
      ]);
    }),
  ];
  if (Arr.isReadonlyArrayNonEmpty(issues)) return { items: prev, statements: [], issues };
  const renamed = (type: string, attribute: string): string =>
    Option.match(
      Arr.findFirst(triples, ([t, from]) => t === type && from === attribute),
      { onNone: () => attribute, onSome: ([, , to]) => to },
    );
  return {
    items: Arr.map(prev, (item) => ({
      ...item,
      attributes: Arr.map(item.attributes, (a) => ({ ...a, name: renamed(label(item), a.name) })),
    })),
    statements: triples.flatMap(([type, from, to]) =>
      Arr.fromOption(
        Option.map(
          R.get(recorded, type),
          (each) =>
            `ALTER TYPE ${qualified(each)} RENAME ATTRIBUTE ${ident(from)} TO ${ident(to)};`,
        ),
      ),
    ),
    issues: [],
  };
};

/** The `[from, to]` of each domain or composite type hint. */
const objectHints = (
  renames: ReadonlyArray<ExtrasRename>,
  kind: "domain" | "compositeType",
): ReadonlyArray<readonly [string, string]> =>
  renames.flatMap((hint) => (hint[0] === kind ? [[hint[1], hint[2]] as const] : []));

/** The `[type, from, to]` of each attribute hint. */
const attributeHints = (
  renames: ReadonlyArray<ExtrasRename>,
): ReadonlyArray<readonly [string, string, string]> =>
  renames.flatMap((hint) =>
    hint[0] === "attribute" ? [[hint[1], hint[2], hint[3]] as const] : [],
  );

// ── The plan ────────────────────────────────────────────────────────────

/** A plan whose `issues` are split by whether a hand-written migration can resolve them. */
interface SplitPlan {
  readonly statements: ReadonlyArray<string>;
  /** Duplicate declarations and bad rename hints: nothing can be recorded. */
  readonly blocking: ReadonlyArray<string>;
  /** Changes Postgres can't `ALTER`: a recordOnly migration can carry them. */
  readonly refused: ReadonlyArray<string>;
}

const planSplit = (
  prev: ExtrasState,
  next: ExtrasState,
  renames: ReadonlyArray<ExtrasRename>,
): SplitPlan => {
  const declarationIssues = [
    ...duplicates("extension", next.extensions, extensionKey),
    ...duplicates("domain", next.domains, label),
    ...duplicates("composite type", next.compositeTypes, label),
  ];
  if (Arr.isReadonlyArrayNonEmpty(declarationIssues)) {
    return { statements: [], blocking: declarationIssues, refused: [] };
  }
  const domainRenames = renameObjects(
    "domain",
    "DOMAIN",
    prev.domains,
    next.domains,
    objectHints(renames, "domain"),
  );
  const typeRenames = renameObjects(
    "composite type",
    "TYPE",
    prev.compositeTypes,
    next.compositeTypes,
    objectHints(renames, "compositeType"),
  );
  const attributeRenames = renameAttributes(
    typeRenames.items,
    next.compositeTypes,
    attributeHints(renames),
  );
  const hintIssues = [
    ...domainRenames.issues,
    ...typeRenames.issues,
    ...(Arr.isReadonlyArrayNonEmpty(typeRenames.issues) ? [] : attributeRenames.issues),
  ];
  if (Arr.isReadonlyArrayNonEmpty(hintIssues)) {
    return { statements: [], blocking: hintIssues, refused: [] };
  }
  const extensions = planKind(
    prev.extensions,
    next.extensions,
    extensionKey,
    createExtension,
    statementsOnly(alterExtension),
    (each) => `DROP EXTENSION IF EXISTS ${ident(each.name)};`,
  );
  const domains = planKind(
    domainRenames.items,
    next.domains,
    label,
    createDomain,
    alterDomain,
    (each) => `DROP DOMAIN ${qualified(each)};`,
  );
  const types = planKind(
    attributeRenames.items,
    next.compositeTypes,
    label,
    createCompositeType,
    statementsOnly(alterCompositeType),
    (each) => `DROP TYPE ${qualified(each)};`,
  );
  return {
    statements: [
      ...extensions.upserts.statements,
      ...domainRenames.statements,
      ...domains.upserts.statements,
      ...typeRenames.statements,
      ...attributeRenames.statements,
      ...types.upserts.statements,
      ...types.drops,
      ...domains.drops,
      ...extensions.drops,
    ],
    blocking: [],
    refused: [...extensions.upserts.issues, ...domains.upserts.issues, ...types.upserts.issues],
  };
};

/**
 * The SQL that moves the database from `prev` to `next`: creates and alters
 * of extensions, then domains, then composite types, then the drops in the
 * reverse order. A recorded domain or composite type (or an attribute) that
 * `renames` names is renamed in place before its kind's alters, instead of
 * dropped and re-created. Pure; a non-empty `issues` blocks the plan.
 *
 * @example
 * ```ts
 * import { domain, emptyExtrasState, planExtras, toExtrasState } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
 *
 * const prev = toExtrasState({ domains: [domain("mail", "text")] });
 * const next = toExtrasState({ domains: [domain("email", "text")] });
 * const plan = planExtras(prev, next, [["domain", "mail", "email"]]);
 * // plan.statements: ['ALTER DOMAIN "public"."mail" RENAME TO "email";']
 * console.log(plan.statements, planExtras(emptyExtrasState, next).statements);
 * ```
 */
export const planExtras = (
  prev: ExtrasState,
  next: ExtrasState,
  renames: ReadonlyArray<ExtrasRename> = [],
): ExtrasPlan => {
  const plan = planSplit(prev, next, renames);
  return {
    statements: Arr.isReadonlyArrayNonEmpty(plan.blocking) ? [] : plan.statements,
    issues: [...plan.blocking, ...plan.refused],
  };
};

/** The extras plan as the contents of a `migration.sql`, statements split by `--> statement-breakpoint`. */
export const renderExtrasMigration = (statements: ReadonlyArray<string>): string =>
  "-- Generated by generateExtrasMigration (@thomasfosterau/effect-drizzle-ext-pg/Tooling): " +
  `change the extras declarations, not this file. ${EXTRAS_STATE_FILE} records the state after it.\n` +
  statements.join(BREAKPOINT) +
  "\n";

// ── drizzle-kit ─────────────────────────────────────────────────────────

/** `drizzle-kit generate` didn't report `ok`; `output` is what it printed. */
export class DrizzleKitError extends Schema.TaggedError<DrizzleKitError>()("DrizzleKitError", {
  output: Schema.String,
}) {
  override get message(): string {
    return `drizzle-kit generate --custom failed:\n${this.output}`;
  }
}

const GenerateOk = Schema.fromJsonString(
  Schema.Struct({ status: Schema.Literal("ok"), migration_path: Schema.String }),
);

/** How drizzle-kit finds the schema and the migrations directory. */
export type DrizzleKitTarget =
  /** A `drizzle.config.ts` (relative to `cwd`), whose `out` must be the `migrationsDir`. */
  | { readonly config: string }
  /** A schema path drizzle-kit loads (relative to `cwd`), with `out` set to the `migrationsDir`. */
  | { readonly schema: string };

/** The inputs {@link generateExtrasMigration} takes. */
export interface GenerateExtrasOptions {
  /** The declared extras. */
  readonly extras: Extras;
  /** The drizzle-kit migrations directory. */
  readonly migrationsDir: string;
  /** The migration's slug, drizzle-kit's `--name`. */
  readonly name: string;
  /** How drizzle-kit is configured. */
  readonly drizzleKit: DrizzleKitTarget;
  /** The command that runs drizzle-kit; `["drizzle-kit"]` (resolved on `PATH`) when absent. */
  readonly command?: Arr.NonEmptyReadonlyArray<string>;
  /** The directory drizzle-kit runs in; the process's own when absent. */
  readonly cwd?: string;
  /**
   * Renames to apply in place of a drop and a create, e.g.
   * `[["domain", "old", "new"], ["attribute", "money", "currency", "code"]]`.
   * They are used once, for this migration: leave them out afterwards.
   */
  readonly renames?: ReadonlyArray<ExtrasRename>;
  /**
   * Record the declared state without generating SQL: the migration's
   * `migration.sql` is left for you to write, for a change the generator
   * refuses (a domain's base type). It still fails on duplicate declarations
   * and bad rename hints.
   */
  readonly recordOnly?: boolean;
}

/** The migration {@link generateExtrasMigration} wrote. */
export interface GeneratedExtrasMigration {
  /** The migration directory drizzle-kit created. */
  readonly dir: string;
  /** The generated statements; empty for a `recordOnly` migration, whose SQL is hand-written. */
  readonly statements: ReadonlyArray<string>;
  /** Whether `migration.sql` awaits hand-written SQL. */
  readonly recordOnly: boolean;
}

/** A comment block, one `-- ` line per line of `text`. */
const commented = (text: string): string =>
  text
    .split("\n")
    .map((line) => `-- ${line}`.trimEnd())
    .join("\n");

/**
 * The placeholder `migration.sql` of a `recordOnly` migration: what to write,
 * and, as comments, what the generator refused and what it would have run.
 */
export const renderRecordOnlyMigration = (plan: ExtrasPlan): string =>
  [
    `-- Hand-written extras migration. ${EXTRAS_STATE_FILE} beside it records the declared state;`,
    "-- write the SQL that moves the database there below, with `--> statement-breakpoint`",
    "-- between statements.",
    ...(Arr.isReadonlyArrayNonEmpty(plan.issues)
      ? ["--", "-- The generator refused:", ...plan.issues.map(commented)]
      : []),
    ...(Arr.isReadonlyArrayNonEmpty(plan.statements)
      ? ["--", "-- What it would have generated otherwise:", ...plan.statements.map(commented)]
      : []),
    "",
  ].join("\n");

const runDrizzleKit = Effect.fn("Tooling.runDrizzleKit")(function* (
  options: GenerateExtrasOptions,
): Effect.fn.Return<string, DrizzleKitError | PlatformError, ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner;
  const [bin, ...prefix] = options.command ?? ["drizzle-kit"];
  const target =
    "config" in options.drizzleKit
      ? ["--config", options.drizzleKit.config]
      : [
          "--dialect",
          "postgresql",
          "--schema",
          options.drizzleKit.schema,
          "--out",
          options.migrationsDir,
        ];
  const args = [
    ...prefix,
    "generate",
    "--custom",
    "--name",
    options.name,
    ...target,
    "--output",
    "json",
  ];
  const output = yield* spawner.string(
    ChildProcess.make(bin, args, options.cwd === undefined ? {} : { cwd: options.cwd }),
    { includeStderr: false },
  );
  // `--output json` prints one JSON envelope line, last.
  const envelope = Option.getOrElse(
    Arr.findLast(output.split("\n"), (line) => Str.isNonEmpty(line.trim())),
    () => "",
  );
  return yield* Schema.decodeEffect(GenerateOk)(envelope).pipe(
    Effect.map((ok) => ok.migration_path),
    Effect.mapError(() => new DrizzleKitError({ output })),
  );
});

/**
 * Plan the declared extras against the recorded state and, when the plan has
 * statements, write them as a new drizzle-kit custom migration with its
 * {@link EXTRAS_STATE_FILE}. Succeeds with `Option.none()` when there is
 * nothing to migrate (and writes nothing); fails with {@link ExtrasError}
 * when the plan has issues, or {@link DrizzleKitError} when drizzle-kit
 * doesn't create the directory (or creates it outside `migrationsDir`).
 * `renames` turns a drop plus a create into a rename; `recordOnly` writes the
 * state with a `migration.sql` for you to fill in, for a change it refuses.
 *
 * @example
 * ```ts
 * // An application's `db:generate-extras` task, run with `NodeRuntime.runMain`.
 * import * as NodeServices from "@effect/platform-node/NodeServices";
 * import { domain, extension, generateExtrasMigration } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
 * import * as Effect from "effect/Effect";
 *
 * export const program = generateExtrasMigration({
 *   extras: {
 *     extensions: [extension("citext")],
 *     domains: [domain("email", "citext", { notNull: true })],
 *   },
 *   migrationsDir: "packages/database/migrations",
 *   name: "email-domain",
 *   drizzleKit: { config: "packages/database/drizzle.config.ts" },
 * }).pipe(Effect.provide(NodeServices.layer));
 * ```
 */
export const generateExtrasMigration = Effect.fn("Tooling.generateExtrasMigration")(function* (
  options: GenerateExtrasOptions,
): Effect.fn.Return<
  Option.Option<GeneratedExtrasMigration>,
  ExtrasError | MalformedExtrasState | DrizzleKitError | PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { state } = yield* readExtrasState(options.migrationsDir);
  const next = toExtrasState(options.extras);
  const recordOnly = options.recordOnly ?? false;
  const plan = planSplit(state, next, options.renames ?? []);
  const issues = recordOnly ? plan.blocking : [...plan.blocking, ...plan.refused];
  if (Arr.isReadonlyArrayNonEmpty(issues)) return yield* new ExtrasError({ issues });
  if (!Arr.isReadonlyArrayNonEmpty(plan.statements) && !Arr.isReadonlyArrayNonEmpty(plan.refused)) {
    return Option.none();
  }
  const migrationPath = yield* runDrizzleKit(options);
  const base = options.cwd ?? path.resolve(".");
  const dir = path.dirname(path.resolve(base, migrationPath));
  if (path.dirname(dir) !== path.resolve(base, options.migrationsDir)) {
    return yield* new DrizzleKitError({
      output: `drizzle-kit wrote ${migrationPath}, outside the migrations directory ${options.migrationsDir}; its config's \`out\` must be that directory.`,
    });
  }
  yield* fs.writeFileString(
    path.join(dir, "migration.sql"),
    recordOnly
      ? renderRecordOnlyMigration({ statements: plan.statements, issues: plan.refused })
      : renderExtrasMigration(plan.statements),
  );
  yield* fs.writeFileString(
    path.join(dir, EXTRAS_STATE_FILE),
    `${yield* Schema.encodeEffect(Schema.fromJsonString(ExtrasState, { space: 2 }))(next).pipe(Effect.orDie)}\n`,
  );
  return Option.some({ dir, statements: recordOnly ? [] : plan.statements, recordOnly });
});

// ── The gate ────────────────────────────────────────────────────────────

/** The declared extras differ from the recorded state; `statements` is what a new migration would run. */
export class ExtrasDriftError extends Schema.TaggedError<ExtrasDriftError>()("ExtrasDriftError", {
  recordedIn: Schema.Option(Schema.String),
  statements: Schema.Array(Schema.String),
}) {
  override get message(): string {
    const where = Option.match(this.recordedIn, {
      onNone: () => "nothing recorded yet",
      onSome: (dir) => `${dir}/${EXTRAS_STATE_FILE}`,
    });
    return (
      `Extras drift detected against the recorded state (${where}): ` +
      `${this.statements.length} statement(s) would be generated:\n\n` +
      this.statements.map((statement) => `  ${statement}`).join("\n") +
      "\n\nFix: run generateExtrasMigration and commit the migration it writes " +
      "(with renames for a renamed domain, type or attribute, or recordOnly for a change it refuses)."
    );
  }
}

/** The inputs {@link checkExtrasDrift} takes. */
export interface ExtrasDriftOptions {
  /** The declared extras. */
  readonly extras: Extras;
  /** The committed drizzle-kit migrations directory. */
  readonly migrationsDir: string;
}

/**
 * Fail with {@link ExtrasDriftError} when the declared extras differ from the
 * state recorded under `migrationsDir`, or with {@link ExtrasError} when they
 * can't be planned at all. Succeeds with the recorded directory. Needs no
 * database and no drizzle-kit.
 *
 * @example
 * ```ts
 * import * as NodeServices from "@effect/platform-node/NodeServices";
 * import { checkExtrasDrift, extension } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
 * import * as Effect from "effect/Effect";
 *
 * export const program = checkExtrasDrift({
 *   extras: { extensions: [extension("vector")] },
 *   migrationsDir: "packages/database/migrations",
 * }).pipe(Effect.provide(NodeServices.layer));
 * ```
 */
export const checkExtrasDrift = Effect.fn("Tooling.checkExtrasDrift")(function* (
  options: ExtrasDriftOptions,
): Effect.fn.Return<
  Option.Option<string>,
  ExtrasDriftError | ExtrasError | MalformedExtrasState | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const recorded = yield* readExtrasState(options.migrationsDir);
  const plan = planExtras(recorded.state, toExtrasState(options.extras));
  if (Arr.isReadonlyArrayNonEmpty(plan.issues)) {
    return yield* new ExtrasError({ issues: plan.issues });
  }
  if (Arr.isReadonlyArrayNonEmpty(plan.statements)) {
    return yield* new ExtrasDriftError({
      recordedIn: recorded.dir,
      statements: plan.statements,
    });
  }
  return recorded.dir;
});
