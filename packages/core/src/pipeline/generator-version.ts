/**
 * Generator-version stamp + downgrade guard (§4.3.1).
 *
 * `aipm build` stamps every sentinel-carrying artifact with the `@ai-plugin-marketplace/core`
 * (generation-engine) version that produced it (see `sentinel.ts`). On the NEXT build, if the
 * installed core version is OLDER than the version stamped into an existing committed artifact,
 * the build REFUSES rather than silently reverting the file to the older generator's output — the
 * exact failure mode where a stale `node_modules` in one checkout undoes a shipped fix.
 *
 * This module owns (a) reading core's own package version at runtime (never hardcoded — a literal
 * would silently drift from the real release) and (b) the pure downgrade comparison. All version
 * ordering uses semver precedence, never string comparison.
 *
 * @see docs/specs/architecture.md §4.3.1 (generator-version stamp + downgrade guard)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';

/** The generation-engine package whose version is stamped and guarded on. */
const GENERATOR_PACKAGE = '@ai-plugin-marketplace/core';

/**
 * Read this package's `package.json#version` (the generation-engine version), resolved relative to
 * this module's location. When bundled to `dist/pipeline/generator-version.js` this resolves
 * `<pkgRoot>/package.json`; run from source as `src/pipeline/generator-version.ts` it resolves the
 * same file (both sit two levels up). Mirrors the version resolution in `init.ts` / `cli/run.ts`.
 *
 * Never hardcode the version: a literal reports a stale value on every release, defeating the very
 * guard that depends on knowing which toolkit is actually running.
 */
export function getGeneratorVersion(): string {
  const here = fileURLToPath(import.meta.url);
  const pkgPath = path.join(path.dirname(here), '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}

/** Render the canonical `@ai-plugin-marketplace/core@<version>` identity used in guard messages. */
export function formatGeneratorId(version: string): string {
  return `${GENERATOR_PACKAGE}@${version}`;
}

/** An existing on-disk generated artifact and the generator version stamped into it (§4.3.1). */
export interface StampedArtifact {
  /** Path of the artifact (repo-relative preferred for readable messages). */
  path: string;
  /** The `@ai-plugin-marketplace/core` version recorded in the artifact's sentinel. */
  version: string;
}

/**
 * Thrown when the installed generator is older than the version that produced an existing artifact
 * and `--force-downgrade` was not given. Carries the offending versions so callers can format or
 * assert on them.
 */
export class GeneratorDowngradeError extends Error {
  constructor(
    /** The installed (running) core version. */
    readonly installedVersion: string,
    /** The newest generator version found stamped across existing artifacts. */
    readonly stampedVersion: string,
    /** The first artifact whose stamp is newer than the installed version. */
    readonly artifactPath: string,
  ) {
    super(
      `Refusing to build: the installed generator ${formatGeneratorId(installedVersion)} is OLDER ` +
        `than ${formatGeneratorId(stampedVersion)}, which produced an existing committed artifact ` +
        `(${artifactPath}). Building with the older toolkit would silently revert generated files ` +
        `to its output. Run \`pnpm install\` to update ${GENERATOR_PACKAGE} to at least ` +
        `${stampedVersion}, or pass --force-downgrade to override this guard.`,
    );
    this.name = 'GeneratorDowngradeError';
  }
}

/**
 * The newest stamped version strictly greater (semver) than `installedVersion` among `stamped`,
 * with the first artifact carrying it. Stamps that are not valid semver, or that are equal-or-older
 * than the installed version, impose no constraint. Returns `undefined` when nothing is newer.
 *
 * "First artifact" is the earliest entry in `stamped` order whose version equals the maximum newer
 * stamp — deterministic given callers pass artifacts in discovery order.
 */
export function findNewestDowngrade(
  installedVersion: string,
  stamped: readonly StampedArtifact[],
): StampedArtifact | undefined {
  // A malformed installed version can't be ordered — don't block a build on that (fail open).
  if (semver.valid(installedVersion) === null) return undefined;

  let worst: StampedArtifact | undefined;
  for (const artifact of stamped) {
    if (semver.valid(artifact.version) === null) continue; // unparseable stamp → no constraint
    if (!semver.gt(artifact.version, installedVersion)) continue; // equal-or-older → allowed
    if (worst === undefined || semver.gt(artifact.version, worst.version)) {
      worst = artifact;
    }
  }
  return worst;
}

/**
 * Enforce the downgrade guard (§4.3.1): throw {@link GeneratorDowngradeError} if any existing
 * artifact was stamped by a NEWER generator than the one now installed, unless `forceDowngrade` is
 * set. Equal-or-newer installed versions, unstamped artifacts, and an empty set all pass (the build
 * proceeds and restamps with the installed version).
 *
 * @throws {GeneratorDowngradeError} On a refused downgrade.
 */
export function assertGeneratorNotDowngraded(
  installedVersion: string,
  stamped: readonly StampedArtifact[],
  forceDowngrade = false,
): void {
  if (forceDowngrade) return;
  const downgrade = findNewestDowngrade(installedVersion, stamped);
  if (downgrade !== undefined) {
    throw new GeneratorDowngradeError(installedVersion, downgrade.version, downgrade.path);
  }
}
