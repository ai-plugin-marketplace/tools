/**
 * `runInit` — scaffold a thin consumer repo (the "template") that depends on
 * `@ai-plugin-marketplace/cli` and holds plugin sources only (§3.2, §11).
 *
 * This is the filesystem-writing orchestrator behind the public `init` operation and the
 * `aipm init [dir]` CLI surface. The generated file *contents* live in `init-template.ts`; this
 * module is the I/O boundary: it resolves the toolkit version to pin, refuses to clobber a
 * non-empty target, and writes the seed tree.
 *
 * **Version pinning (§9.1 lockstep release).** core and cli ship in lockstep, so the `cli` dev
 * dependency is pinned to a caret of core's *own* version — read at runtime from this package's
 * `package.json`, resolved relative to {@link import.meta.url} exactly as `load-config.ts` resolves
 * the package entrypoint. Today that yields `^0.1.0-alpha.0`; once 0.1.0 ships, an `init` run from
 * the published cli pins `^0.1.0`.
 *
 * @see docs/specs/architecture.md §3.2 (template repo contents)
 * @see docs/specs/architecture.md §9.1 (lockstep release lines)
 * @see docs/specs/architecture.md §11 (template→toolkit dependency contract)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInitFiles } from './init-template.js';
import type { InitOptions } from './types.js';

/**
 * Read this package's `package.json#version`, resolved relative to this module's location.
 *
 * When bundled to `dist/pipeline/init.js` this resolves `<pkgRoot>/package.json`; when run from
 * source as `src/pipeline/init.ts` it resolves the same file (both sit two levels up). Mirrors the
 * version-resolution approach in `cli/src/run.ts` and the entrypoint resolution in
 * `load-config.ts`.
 */
function coreVersion(): string {
  const here = fileURLToPath(import.meta.url);
  // here = <pkgRoot>/<src|dist>/pipeline/init.<ts|js>; package.json sits two levels up.
  const pkgPath = path.join(path.dirname(here), '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
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
 * Writes `package.json` (with the `@ai-plugin-marketplace/cli` dev dependency pinned to a caret of
 * the current toolkit version), `.gitignore`, `README.md`, both repo-root marketplace registries
 * (`{ "plugins": [] }`), an empty `plugins/` (tracked via `.gitkeep`), and a CI workflow that runs
 * `aipm build` then `aipm validate` (§10.5 freshness). The repo name defaults to
 * `basename(targetDir)`; override it with `opts.name`.
 *
 * **Refuses to clobber.** If `targetDir` exists and is a non-empty directory (or exists as a
 * non-directory), the function throws and writes nothing. Creating into a fresh or empty directory
 * is fine.
 *
 * @param targetDir - Absolute or relative path to the directory to scaffold into.
 * @param opts - Init options; `name` overrides the derived repo name.
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

  const name = opts.name ?? path.basename(resolved);
  const files = buildInitFiles(name, coreVersion());

  fs.mkdirSync(resolved, { recursive: true });
  for (const file of files) {
    const full = path.join(resolved, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content, 'utf-8');
  }

  return Promise.resolve();
}
