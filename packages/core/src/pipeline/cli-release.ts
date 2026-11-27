import { readFileSync } from 'node:fs';
import semver from 'semver';

export const CLI_PACKAGE_NAME = '@ai-plugin-marketplace/cli';

export function normalizeRegistryRange(range: string): string | null {
  // Reject paths, protocols and archive suffixes before the loose parser can discard them.
  if (/[/\\:]/.test(range) || /\.(?:tgz|tar\.gz|tar)$/i.test(range.trimEnd())) {
    return null;
  }
  // Preserve strict input as written, including shorthand and build identifiers.
  return semver.validRange(range) === null ? semver.validRange(range, { loose: true }) : range;
}

export function isNpmPublishVersion(version: unknown): boolean {
  // npm's publish manifest uses semver.clean(), which discards build identifiers.
  return typeof version === 'string' && semver.clean(version) === version;
}

export function validateCliRelease(value: unknown, source: string) {
  const { name, version } = (value ?? {}) as { name?: unknown; version?: unknown };
  const parsed = typeof version === 'string' ? semver.parse(version) : null;
  const canonical = parsed?.build.length
    ? `${parsed.version}+${parsed.build.join('.')}`
    : parsed?.version;
  if (
    name !== CLI_PACKAGE_NAME ||
    typeof version !== 'string' ||
    version !== canonical ||
    normalizeRegistryRange(`^${version}`) !== `^${version}` ||
    !semver.satisfies(version, `^${version}`)
  ) {
    throw new Error(
      `Invalid CLI release metadata in '${source}': expected ${CLI_PACKAGE_NAME} with a valid version that can be used as a caret range.`,
    );
  }
  return { name, version };
}

export function readCliRelease(releaseFile: URL) {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(releaseFile, 'utf8'));
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      throw new Error(`CLI release metadata is missing at '${releaseFile.href}'.`, { cause });
    }
    throw new Error(`Invalid CLI release metadata in '${releaseFile.href}'.`, { cause });
  }
  return validateCliRelease(value, releaseFile.href);
}
