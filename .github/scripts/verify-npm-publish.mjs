#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  isNpmPublishVersion,
  validateCliRelease,
} from '../../packages/core/dist/pipeline/cli-release.js';

function requireFile(archive, path) {
  const listing = execFileSync('tar', ['-tvf', archive, '--', path], { encoding: 'utf8' });
  if (!listing.startsWith('-')) {
    throw new Error(`Expected a regular file at '${path}' in '${archive}'.`);
  }
}

function readManifest(archive, path) {
  requireFile(archive, path);
  return JSON.parse(execFileSync('tar', ['-xOf', archive, '--', path], { encoding: 'utf8' }));
}

function requirePublishVersion({ name, version }) {
  if (!isNpmPublishVersion(version)) {
    throw new Error(`Expected ${name}@${version} to have a version npm publishes unchanged.`);
  }
}

function verify(archive, cliArchive) {
  const manifest = readManifest(archive, 'package/package.json');
  const expected = validateCliRelease(readManifest(cliArchive, 'package/package.json'), cliArchive);
  requirePublishVersion(expected);
  requirePublishVersion(manifest);

  if (manifest.name === '@ai-plugin-marketplace/core') {
    const path = 'package/dist/cli-release/package.json';
    const metadata = readManifest(archive, path);
    const bundled = validateCliRelease(metadata, path);
    if (Object.keys(metadata).length !== 2 || bundled.version !== expected.version) {
      throw new Error(
        `Bundled CLI release metadata must contain only the name and version of ${expected.name}@${expected.version}.`,
      );
    }

    const rootExport = manifest.exports?.['.'];
    for (const entry of new Set([
      manifest.main,
      manifest.types,
      rootExport?.import,
      rootExport?.types,
    ])) {
      if (typeof entry !== 'string' || !entry.startsWith('./')) {
        throw new Error('Core must declare runtime and types entry points.');
      }
      requireFile(archive, `package/${entry.slice(2)}`);
    }
    requireFile(archive, 'package/dist/pipeline/cli-release.js');
  } else {
    const release = validateCliRelease(manifest, archive);
    if (release.version !== expected.version) {
      throw new Error(
        `CLI publish tarball differs from the release CLI identity ${expected.name}@${expected.version}.`,
      );
    }
  }
}

// pnpm 10 packs the package, then invokes npm with the exact archive it is about to publish.
const args = process.argv.slice(2);
const [command, option, archive] = args;
const cliArchive = process.env.AIPM_RELEASE_CLI_TARBALL;
if (
  command !== 'publish' ||
  option !== '--ignore-scripts' ||
  !archive?.endsWith('.tgz') ||
  !cliArchive
) {
  throw new Error(
    'Expected pnpm to supply a publish tarball and AIPM_RELEASE_CLI_TARBALL to be set.',
  );
}
verify(archive, cliArchive);
const { npm_config_npm_path: _npmPath, ...env } = process.env;
const result = spawnSync('npm', args, { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
