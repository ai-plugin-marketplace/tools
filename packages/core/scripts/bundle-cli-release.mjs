import { mkdirSync, writeFileSync } from 'node:fs';
import { readCliRelease } from '../dist/pipeline/cli-release.js';

const release = readCliRelease(new URL('../../cli/package.json', import.meta.url));
const destination = new URL('../dist/cli-release/', import.meta.url);

mkdirSync(destination, { recursive: true });
writeFileSync(new URL('package.json', destination), JSON.stringify(release) + '\n');
