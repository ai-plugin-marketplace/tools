#!/usr/bin/env node
import { run } from './run.js';

void run(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`aipm: ${message}\n`);
    process.exit(1);
  },
);
