import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const source = new URL('../../cli/package.json', import.meta.url);
const bundled = new URL('../dist/cli-release/package.json', import.meta.url);

function readManifest(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

if (!existsSync(bundled)) {
  throw new Error(
    'Bundled CLI release metadata is missing. Run pnpm clean and pnpm build before packing core.',
  );
}
if (!isDeepStrictEqual(readManifest(bundled), readManifest(source))) {
  throw new Error(
    'Bundled CLI release metadata is stale. Run pnpm clean and pnpm build before packing core.',
  );
}
