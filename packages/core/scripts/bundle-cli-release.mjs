import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const directory = new URL('../dist/', import.meta.url);
const output = new URL('cli-release.json', directory);
const temporaryOutput = new URL(`cli-release.${process.pid}.tmp`, directory);

// Changesets updates the CLI manifest before the release build.
const { name, version } = JSON.parse(
  readFileSync(new URL('../../cli/package.json', import.meta.url), 'utf8'),
);

// Build and typecheck can run concurrently. Readers always see a complete manifest.
try {
  writeFileSync(temporaryOutput, JSON.stringify({ name, version }));
  renameSync(temporaryOutput, output);
} finally {
  rmSync(temporaryOutput, { force: true });
}
