import { copyFileSync, mkdirSync } from 'node:fs';

const source = new URL('../../cli/package.json', import.meta.url);
const destination = new URL('../dist/cli-release/', import.meta.url);

mkdirSync(destination, { recursive: true });
copyFileSync(source, new URL('package.json', destination));
