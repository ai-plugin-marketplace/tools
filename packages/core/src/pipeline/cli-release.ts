import { readFileSync } from 'node:fs';
import semver from 'semver';

export const CLI_PACKAGE_NAME = '@ai-plugin-marketplace/cli';

export function readCliRelease(releaseFile: URL) {
  const invalid = `Invalid CLI release metadata in '${releaseFile.href}': expected ${CLI_PACKAGE_NAME} with a valid version that can be used as a caret range.`;
  let manifest: { name?: unknown; version?: unknown } | null;
  try {
    manifest = JSON.parse(readFileSync(releaseFile, 'utf8')) as typeof manifest;
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      throw new Error(`CLI release metadata is missing at '${releaseFile.href}'.`, { cause });
    }
    throw new Error(invalid, { cause });
  }

  const version =
    manifest?.name === CLI_PACKAGE_NAME && typeof manifest.version === 'string'
      ? semver.valid(manifest.version)
      : null;
  if (version === null || !semver.satisfies(version, `^${version}`)) {
    throw new Error(invalid);
  }
  return { manifest, version };
}
