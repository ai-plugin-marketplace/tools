/**
 * CLI dispatcher.
 *
 * Maps `aipm <command>` to `@ai-plugin-marketplace/core` operations, formats output, and returns
 * a process exit code. No business logic lives here (§8.2): argument parsing, human-readable
 * formatting, and exit codes only.
 *
 *   aipm build [path]
 *   aipm validate [path]
 *   aipm scaffold <name>
 *   aipm migrate [path]
 *   aipm check-support <plugin>
 *   aipm add-target <plugin> <target>
 *   aipm list-targets
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addTarget,
  build,
  checkSupport,
  listTargets,
  migrate,
  scaffold,
  validate,
} from '@ai-plugin-marketplace/core';
import type {
  Finding,
  SupportReport,
  TargetId,
  ValidationResult,
} from '@ai-plugin-marketplace/core';

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

/** Read this package's version from its own package.json, resolved relative to the compiled file. */
function toolkitVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}

/** Resolve a `<plugin>` CLI argument to a plugin directory: an explicit path, else `<cwd>/plugins/<arg>`. */
function resolvePluginDir(arg: string): string {
  const asPath = path.resolve(arg);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) return asPath;
  return path.join(process.cwd(), 'plugins', arg);
}

/** Format a single finding as `[plugin] code (severity): message`, with an indented hint line. */
function formatFinding(f: Finding): string {
  const scope = f.plugin !== undefined ? `[${f.plugin}] ` : '';
  const head = `${scope}${f.code} (${f.severity}): ${f.message}`;
  return f.hint !== undefined ? `${head}\n    hint: ${f.hint}` : head;
}

/** Write a validation result to the given stream; returns true iff it passed (no hard findings). */
function reportValidation(result: ValidationResult, out: NodeJS.WritableStream): boolean {
  for (const finding of result.findings) {
    out.write(`${formatFinding(finding)}\n`);
  }
  if (result.passed) {
    out.write(result.findings.length === 0 ? 'OK — no findings.\n' : 'OK — no hard findings.\n');
  }
  return result.passed;
}

function reportSupport(report: SupportReport, out: NodeJS.WritableStream): void {
  out.write(`${report.plugin}: declared [${report.declared.join(', ')}]\n`);
  for (const { target, missing } of report.missingArtifacts) {
    out.write(`  missing for ${target}: ${missing.join(', ')}\n`);
  }
  for (const { target, wouldNeed } of report.suggestions) {
    out.write(`  could add ${target} (would need: ${wouldNeed.join(', ')})\n`);
  }
}

export async function run(argv: readonly string[], opts: RunOptions = {}): Promise<number> {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;

  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    out.write(HELP);
    return 0;
  }

  if (command === '--version' || command === '-V') {
    out.write(`${toolkitVersion()}\n`);
    return 0;
  }

  try {
    switch (command) {
      case 'build': {
        const target = rest[0] ?? process.cwd();
        const results = await build(target);
        const artifactCount = results.reduce((n, r) => n + r.artifacts.length, 0);
        out.write(
          `Built ${String(results.length)} plugin(s), ${String(artifactCount)} artifact(s).\n`,
        );
        // §5.4: build runs validate before reporting success.
        const result = await validate(target);
        const passed = reportValidation(result, out);
        return passed ? 0 : 1;
      }

      case 'validate': {
        const target = rest[0] ?? process.cwd();
        const result = await validate(target);
        const passed = reportValidation(result, out);
        return passed ? 0 : 1;
      }

      case 'scaffold': {
        const name = rest[0];
        if (name === undefined) {
          err.write("aipm: 'scaffold' requires a <name> argument.\n");
          return 2;
        }
        await scaffold(name);
        out.write(`Created plugins/${name}.\n`);
        return 0;
      }

      case 'migrate': {
        const result = await migrate(rest[0] ?? process.cwd());
        out.write(`${result.status}\n`);
        return 0;
      }

      case 'check-support': {
        const plugin = rest[0];
        if (plugin === undefined) {
          err.write("aipm: 'check-support' requires a <plugin> argument.\n");
          return 2;
        }
        const report = await checkSupport(resolvePluginDir(plugin));
        reportSupport(report, out);
        return 0;
      }

      case 'add-target': {
        const plugin = rest[0];
        const target = rest[1];
        if (plugin === undefined || target === undefined) {
          err.write("aipm: 'add-target' requires <plugin> and <target> arguments.\n");
          return 2;
        }
        const known = listTargets();
        if (!known.includes(target as TargetId)) {
          err.write(`aipm: unknown target '${target}'. Known: ${known.join(', ')}.\n`);
          return 2;
        }
        await addTarget(resolvePluginDir(plugin), target as TargetId);
        out.write(`Added '${target}' to ${plugin}.\n`);
        return 0;
      }

      case 'list-targets': {
        for (const id of listTargets()) {
          out.write(`${id}\n`);
        }
        return 0;
      }

      default: {
        err.write(`aipm: unknown command '${command}'. Run 'aipm --help'.\n`);
        return 2;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    err.write(`aipm: ${command} failed: ${message}\n`);
    return 1;
  }
}
