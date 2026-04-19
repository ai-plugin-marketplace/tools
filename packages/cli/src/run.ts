/**
 * CLI dispatcher.
 *
 * Skeleton implementation. Stage 6 of the bootstrap plan fills in each subcommand by wiring
 * it to `@ai-plugin-marketplace/core`. Subcommand set is fixed per §8.2 of the spec:
 *
 *   aipm build [path]
 *   aipm validate [path]
 *   aipm scaffold <name>
 *   aipm migrate [path]
 *   aipm check-support <plugin>
 *   aipm add-target <plugin> <target>
 *   aipm list-targets
 */

import { listTargets, migrate } from '@ai-plugin-marketplace/core';

interface RunOptions {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

const HELP = `aipm — AI plugin marketplace toolkit

Usage:
  aipm <command> [arguments]

Commands:
  build [path]                  Build plugin artifacts (default: cwd)
  validate [path]               Run validators on plugins (default: cwd)
  scaffold <name>               Create a new plugin from templates
  migrate [path]                Apply schema migrations (no-op in this version)
  check-support <plugin>        Diagnose a plugin's target support envelope
  add-target <plugin> <target>  Scaffold target-specific files for a plugin
  list-targets                  List target IDs this toolkit knows about

Options:
  --help, -h                    Show this help message
  --version, -V                 Print toolkit version
`;

export async function run(argv: readonly string[], opts: RunOptions = {}): Promise<number> {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;

  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    out.write(HELP);
    return 0;
  }

  if (command === '--version' || command === '-V') {
    out.write('0.1.0-alpha.0\n');
    return 0;
  }

  switch (command) {
    case 'list-targets': {
      for (const id of listTargets()) {
        out.write(`${id}\n`);
      }
      return 0;
    }

    case 'migrate': {
      const result = await migrate(rest[0] ?? process.cwd());
      out.write(`${result.status}\n`);
      return 0;
    }

    case 'build':
    case 'validate':
    case 'scaffold':
    case 'check-support':
    case 'add-target': {
      err.write(`aipm: '${command}' is not implemented in this skeleton build.\n`);
      return 2;
    }

    default: {
      err.write(`aipm: unknown command '${command}'. Run 'aipm --help'.\n`);
      return 2;
    }
  }
}
