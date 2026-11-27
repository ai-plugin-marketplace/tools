import { readFileSync } from 'node:fs';
import semver from 'semver';

export const CLI_PACKAGE_NAME = '@ai-plugin-marketplace/cli';

export function isRegistryRange(range: string): boolean {
  // npm can classify archive suffixes as files even when SemVer accepts them.
  return (
    /^[\dA-Za-z.*<>=^~|\s-]+$/.test(range) &&
    !/\.(?:tgz|tar\.gz|tar)$/i.test(range.trimEnd()) &&
    semver.validRange(range) !== null
  );
}

export function validateCliRelease(value: unknown, source: string) {
  const { name, version } = (value ?? {}) as { name?: unknown; version?: unknown };
  if (
    name !== CLI_PACKAGE_NAME ||
    typeof version !== 'string' ||
    semver.valid(version) !== version ||
    !isRegistryRange(`^${version}`) ||
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
