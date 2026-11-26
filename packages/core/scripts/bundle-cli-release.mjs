import { readFileSync, writeFileSync } from 'node:fs';

// Changesets updates the CLI manifest before the release build.
const { name, version } = JSON.parse(
  readFileSync(new URL('../../cli/package.json', import.meta.url), 'utf8'),
);
writeFileSync(
  new URL('../dist/cli-release.json', import.meta.url),
  JSON.stringify({ name, version }),
);
