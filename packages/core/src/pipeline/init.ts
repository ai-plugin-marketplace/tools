/**
 * `runInit` — scaffold a thin consumer repo (the "template") that depends on
 * `@ai-plugin-marketplace/cli` and holds plugin sources only (§3.2, §11).
 *
 * This is the filesystem-writing orchestrator behind the public `init` operation and the
 * `aipm init [dir]` CLI surface. The generated file *contents* live in `init-template.ts`; this
 * module is the I/O boundary: it resolves the versions to pin, refuses to clobber a non-empty
 * target, writes the seed tree, and seeds the `.aipm/scaffold.json` refresh sidecar.
 *
 * **Version pinning.** `cli` and `core` ship independently and may differ (e.g. `cli 0.1.1` ships
 * with `core 0.2.0`), so the generated `package.json` pins each to a caret of its *own* version.
 * `core`'s version is read at runtime from this package's `package.json` (resolved relative to
 * {@link import.meta.url}, exactly as `load-config.ts` resolves the package entrypoint); `cli`'s
 * version is supplied by the cli entrypoint via {@link InitOptions.cliVersion} (it reads its own
 * `package.json`). When `cliVersion` is omitted, it falls back to core's version.
 *
 * @see docs/specs/architecture.md §3.2 (template repo contents)
 * @see docs/specs/architecture.md §11 (template→toolkit dependency contract)
 * @see docs/specs/scaffold-refresh-and-upgrade.md (`aipm init --refresh`)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getGeneratorVersion } from './generator-version.js';
import { buildInitFiles } from './init-template.js';
import { writeScaffoldSidecar } from './scaffold-refresh.js';
import type { InitOptions } from './types.js';

/**
 * Resolve the default marketplace name from the environment: `${USER}-ai-plugins`. Falls back to
 * `$USERNAME` (set on Windows, where `$USER` is typically absent) before giving up and using the
 * `my-ai-plugins` placeholder — which `aipm validate` deliberately flags via
 * `default-marketplace-name`, nudging the author to pass an explicit `--name`.
 *
 * Resolved here in the I/O boundary (not in the pure `init-template.ts`) so the template stays a
 * pure function of its inputs (§: no env reads / clocks in `init-template.ts`).
 */
function defaultMarketplaceName(): string {
  // `$USER` on POSIX, `$USERNAME` on Windows. Treat empty/whitespace as absent so a blank env var
  // falls through to the next candidate rather than producing a `-ai-plugins` name.
  for (const candidate of [process.env['USER'], process.env['USERNAME']]) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) return `${trimmed}-ai-plugins`;
  }
  return 'my-ai-plugins';
}

/**
 * Normalize an explicitly-provided `name`/`marketplaceName` option: `undefined` (caller wants the
 * default) passes through as `undefined`; a non-blank string is returned trimmed; a blank or
 * whitespace-only string is rejected, since it would yield an invalid `package.json` name and an
 * empty marketplace identity. `field` names the option in the error message.
 */
function resolveProvidedName(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid '${field}': must be a non-empty, non-whitespace string.`);
  }
  return trimmed;
}

/**
 * True iff `dir` does not exist, or exists as an empty directory. A non-empty directory (or a
 * path that exists as a non-directory) is treated as "would clobber".
 */
function isFreshTarget(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return false;
  return fs.readdirSync(dir).length === 0;
}

/**
 * Scaffold a thin consumer repo at `targetDir` (§3.2).
 *
 * Writes `package.json` (with `cli`/`core` dev dependencies pinned to carets of their respective
 * versions), `.gitignore`, `README.md`, both repo-root marketplace registries (each named, empty:
 * `{ "name", "owner": { "name" }, "plugins": [] }`), an empty `plugins/` (tracked via `.gitkeep`),
 * and a CI workflow that runs `aipm build` then `aipm validate` (§10.5 freshness). It also seeds
 * `.aipm/scaffold.json` so a later `aipm init --refresh` can tell pristine toolkit-owned files from
 * user edits. The repo name defaults to `basename(targetDir)` (override with `opts.name`); the
 * marketplace name defaults to `${USER}-ai-plugins` (override with `opts.marketplaceName`).
 *
 * **Refuses to clobber.** If `targetDir` exists and is a non-empty directory (or exists as a
 * non-directory), the function throws and writes nothing. Creating into a fresh or empty directory
 * is fine.
 *
 * @param targetDir - Absolute or relative path to the directory to scaffold into.
 * @param opts - Init options; `name` overrides the derived repo name, `marketplaceName` the
 *   default `${USER}-ai-plugins` marketplace name, `cliVersion` the pinned cli dependency version
 *   (defaults to core's version).
 * @throws {Error} When `targetDir` exists and is non-empty (or is not a directory).
 */
export async function runInit(targetDir: string, opts: InitOptions = {}): Promise<void> {
  const resolved = path.resolve(targetDir);

  if (!isFreshTarget(resolved)) {
    throw new Error(
      `Refusing to scaffold into '${resolved}': the directory already exists and is not empty. ` +
        'Choose a new path or an empty directory.',
    );
  }

  // Reject an explicitly-provided but blank `name`/`marketplaceName` at the I/O boundary: an empty
  // or whitespace-only value would otherwise produce an invalid `package.json` name and an empty
  // marketplace identity in the registries. The derived defaults (basename / env-resolved) are
  // trusted and not re-validated here.
  const name = resolveProvidedName(opts.name, 'name') ?? path.basename(resolved);
  // The marketplace name is the identity hosts register under and must be unique across
  // marketplaces (a shared name collides on install). Prefer an explicit `--name`, then the
  // env-derived `${USER}-ai-plugins`, resolved here so `buildInitFiles` stays pure.
  const marketplaceName =
    resolveProvidedName(opts.marketplaceName, 'marketplaceName') ?? defaultMarketplaceName();
  const core = getGeneratorVersion();
  const cli = opts.cliVersion ?? core;
  const files = buildInitFiles(name, marketplaceName, cli, core);

  fs.mkdirSync(resolved, { recursive: true });
  for (const file of files) {
    const full = path.join(resolved, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content, 'utf-8');
  }

  // Seed the refresh sidecar so `aipm init --refresh` has a baseline of toolkit-owned content.
  writeScaffoldSidecar(resolved);

  return Promise.resolve();
}
