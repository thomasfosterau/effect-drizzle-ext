/**
 * @copyright Thomas Foster
 *
 * The module-graph gate for the Drizzle-free root entry (effect-drizzle-ext#191):
 * walks the BUILT files `publishConfig.exports["."]` names in
 * `packages/core/package.json` (its JavaScript and its declarations) through
 * every relative import and re-export, shared content-hashed chunks included,
 * and fails if any file it reaches imports `drizzle-orm` (the package or any
 * of its subpaths). A client-bundled models package imports `.` on that
 * promise; a type-only re-export is enough to break it in the declarations.
 *
 * Runs after `tsc` in this package's `check` task, so `vp run check` gates it
 * against fresh `dist/` output. Imports are read with TypeScript's own
 * `preProcessFile`, which skips comments and strings, so a doc comment's
 * `@example` that names Drizzle is not an import. A relative import whose file
 * is missing fails too: an unread file is an unchecked one.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import ts from "typescript";

/** A file the root entry reaches imports `drizzle-orm`. */
class DrizzleReachedError extends Schema.TaggedError<DrizzleReachedError>()("DrizzleReachedError", {
  message: Schema.String,
}) {}

/** A file the root entry reaches could not be read (a missing relative import). */
class UnreadableModuleError extends Schema.TaggedError<UnreadableModuleError>()(
  "UnreadableModuleError",
  { message: Schema.String },
) {}

/** The one `package.json` member the walk starts from. */
const Manifest = Schema.Struct({
  publishConfig: Schema.Struct({
    exports: Schema.Struct({
      ".": Schema.Struct({ types: Schema.String, default: Schema.String }),
    }),
  }),
});

/** Whether a specifier names `drizzle-orm` or one of its subpaths. */
const isDrizzle = (specifier: string): boolean =>
  specifier === "drizzle-orm" || specifier.startsWith("drizzle-orm/");

/** Whether a specifier is a relative path inside the emitted `dist/`. */
const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

/**
 * Every module specifier a file imports, re-exports or `import()`s (type
 * positions included), read by TypeScript's scanner rather than a regex.
 */
const specifiersOf = (source: string): ReadonlyArray<string> =>
  ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);

/**
 * The file a relative specifier names: a bundled declaration file imports its
 * chunks as `./chunk.js`, whose declarations are the sibling `./chunk.d.ts`.
 */
const targetOf = (from: string, specifier: string): string =>
  from.endsWith(".d.ts") ? specifier.replace(/\.js$/, ".d.ts") : specifier;

/** The `a → b → c` chain a finding names, relative to the package root. */
const describeChain = (root: string, chain: ReadonlyArray<string>, path: Path.Path): string =>
  chain.map((file) => path.relative(root, file)).join(" → ");

/**
 * The files `file` reaches one step on, or a {@link DrizzleReachedError} naming
 * `file`, its `drizzle-orm` import and how the entry reached it.
 */
const nextFiles = (
  root: string,
  chain: Arr.NonEmptyReadonlyArray<string>,
  source: string,
  path: Path.Path,
): Effect.Effect<ReadonlyArray<string>, DrizzleReachedError> => {
  const file = Arr.lastNonEmpty(chain);
  const specifiers = specifiersOf(source);
  return Option.match(Arr.findFirst(specifiers, isDrizzle), {
    onNone: () =>
      Effect.succeed(
        specifiers
          .filter(isRelative)
          .map((specifier) => path.resolve(path.dirname(file), targetOf(file, specifier))),
      ),
    onSome: (specifier) =>
      Effect.fail(
        new DrizzleReachedError({
          message: `${path.relative(root, file)} imports "${specifier}", but the Drizzle-free root entry reaches it: ${describeChain(root, chain, path)}`,
        }),
      ),
  });
};

/** Reads `chain`'s last file, failing with the chain that named it when it is missing. */
const readModule = Effect.fnUntraced(function* (
  root: string,
  chain: Arr.NonEmptyReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = Arr.lastNonEmpty(chain);
  return yield* fs.readFileString(file).pipe(
    Effect.mapError(
      (cause) =>
        new UnreadableModuleError({
          message: `cannot read ${path.relative(root, file)} (${describeChain(root, chain, path)}): ${cause.message}`,
        }),
    ),
  );
});

/**
 * Walks every file reachable from the last file of `chain` that `seen` (the
 * files already walked) does not hold, depth-first and one at a time, failing
 * on the first `drizzle-orm` import; returns `seen` with every walked file.
 */
const visit = Effect.fnUntraced(function* (
  root: string,
  chain: Arr.NonEmptyReadonlyArray<string>,
  seen: HashSet.HashSet<string>,
): Effect.fn.Return<
  HashSet.HashSet<string>,
  DrizzleReachedError | UnreadableModuleError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const source = yield* readModule(root, chain);
  const next = yield* nextFiles(root, chain, source, path);
  return yield* Effect.reduce(
    next,
    () => seen,
    (walked, file) =>
      HashSet.has(walked, file)
        ? Effect.succeed(walked)
        : visit(root, [...chain, file], HashSet.add(walked, file)),
  );
});

/** Walks the root entry's built JavaScript and declarations; see the module comment. */
const checkRootEntry = Effect.fn("checkRootEntry")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../../../packages/core/", import.meta.url));
  const manifest = yield* fs
    .readFileString(path.join(root, "package.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
  const entry = manifest.publishConfig.exports["."];
  const starts = [entry.default, entry.types].map((file) => path.resolve(root, file));
  const walked = yield* Effect.reduce(
    starts,
    () => HashSet.fromIterable(starts),
    (seen, start) => visit(root, [start], seen),
  );
  yield* Effect.log(
    `root entry reaches no drizzle-orm import (${HashSet.size(walked)} built files walked from ${starts.map((file) => path.relative(root, file)).join(", ")})`,
  );
});

NodeRuntime.runMain(checkRootEntry().pipe(Effect.provide(NodeServices.layer)));
