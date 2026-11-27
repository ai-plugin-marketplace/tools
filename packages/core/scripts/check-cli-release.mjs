import { execSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const bundledManifest = 'dist/cli-release/package.json';
const releaseReader = 'dist/pipeline/cli-release.js';
const rebuild = 'Run pnpm build before packing core.';
const core = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const entryPoints = new Set([
  core.main,
  core.types,
  ...Object.values(core.exports).flatMap((target) =>
    typeof target === 'string' ? [target] : Object.values(target),
  ),
]);

function requireFile(file, message) {
  if (!lstatSync(new URL(file, root), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${message} (${file}). ${rebuild}`);
  }
}

requireFile(bundledManifest, 'Bundled CLI release metadata is missing');
for (const file of entryPoints) {
  requireFile(file, 'Core entry point is missing');
}
requireFile(releaseReader, 'Core release reader is missing');

const { readCliRelease } = await import(new URL(releaseReader, root).href);
const bundled = readCliRelease(new URL(bundledManifest, root));
const source = readCliRelease(new URL('../cli/package.json', root));
if (bundled.version !== source.version) {
  throw new Error(`Bundled CLI release metadata is stale. ${rebuild}`);
}

// Ask pnpm for the actual file list so packaging exclusions also fail the prepack check.
const dryRun = execSync('pnpm pack --dry-run --config.ignore-scripts=true --json', {
  cwd: root,
  encoding: 'utf8',
});
const packedFiles = new Set(JSON.parse(dryRun).files.map(({ path }) => path));
for (const file of [...entryPoints, bundledManifest, releaseReader]) {
  if (!packedFiles.has(file.replace(/^\.\//, ''))) {
    throw new Error(`Core package would omit '${file}'. Check the package file inclusion rules.`);
  }
}
