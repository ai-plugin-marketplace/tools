/**
 * CLI dispatcher.
 *
 * Maps `aipm <command>` to `@ai-plugin-marketplace/core` operations, formats output, and returns
 * a process exit code. No business logic lives here (§8.2): argument parsing, human-readable
 * formatting, and exit codes only.
 *
 *   aipm init [dir]
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
  init,
  listTargets,
  migrate,
  refreshScaffold,
  scaffold,
  validate,
} from '@ai-plugin-marketplace/core';
import type {
  Finding,
  RefreshOutcome,
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
  init [dir]                    Scaffold a new plugin repo (default: cwd)
  init --name <name> [dir]      Scaffold a new plugin repo with an explicit marketplace name
  init --refresh [dir]          Update toolkit-owned scaffold files in an existing repo
  build [path]                  Build plugin artifacts (default: cwd)
  validate [path]               Run validators on plugins (default: cwd)
  scaffold <name>               Create a new plugin from templates
  migrate [path]                Apply schema migrations (no-op in this version)
  check-support <plugin>        Diagnose a plugin's target support envelope
  add-target <plugin> <target>  Scaffold target-specific files for a plugin
  list-targets                  List target IDs this toolkit knows about

Options:
  --name <name>                 With init: marketplace name for the new repo
                                (default: $USER-ai-plugins). Must be unique across marketplaces.
  --refresh                     With init: refresh an existing repo instead of creating one
  --force                       With init --refresh: overwrite locally-modified scaffold files
  --help, -h                    Show this help message
  --version, -V                 Print toolkit version
`;

/** Read this package's version from its own package.json, resolved relative to the compiled file. */
function toolkitVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}

/**
 * Extract the value of a `--flag <value>` option from an argument list (supports both
 * `--flag value` and `--flag=value`). Returns the value and the set of indices it consumed so the
 * positional-argument finder can skip them. Returns `undefined` when the flag is absent or trailing
 * with no value.
 */
function takeOptionValue(
  args: readonly string[],
  flag: string,
): { value: string | undefined; consumed: Set<number> } {
  const consumed = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === flag) {
      consumed.add(i);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        consumed.add(i + 1);
        return { value: next, consumed };
      }
      return { value: undefined, consumed };
    }
    if (arg.startsWith(`${flag}=`)) {
      consumed.add(i);
      return { value: arg.slice(flag.length + 1), consumed };
    }
  }
  return { value: undefined, consumed };
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

/** Write a per-file summary of an `init --refresh` run, plus guidance when conflicts were skipped. */
function reportRefresh(outcomes: readonly RefreshOutcome[], out: NodeJS.WritableStream): void {
  for (const o of outcomes) {
    out.write(`${o.status.padEnd(12)} ${o.path}\n`);
  }
  const conflicts = outcomes.filter((o) => o.status === 'conflict');
  if (conflicts.length > 0) {
    out.write(
      `\n${String(conflicts.length)} file(s) have local modifications and were left unchanged.\n`,
    );
    out.write('Review them, then re-run `aipm init --refresh --force` to overwrite.\n');
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
      case 'init': {
        const refresh = rest.includes('--refresh');
        const force = rest.includes('--force');
        const { value: nameOpt, consumed: nameConsumed } = takeOptionValue(rest, '--name');
        // First non-flag argument that wasn't consumed as a `--name` value is the target dir.
        const dir =
          rest.find((arg, i) => !arg.startsWith('-') && !nameConsumed.has(i)) ?? process.cwd();
        if (refresh) {
          const outcomes = await refreshScaffold(dir, { force });
          reportRefresh(outcomes, out);
          // Conflicts are reported, not failures — keep exit 0 so this is script-safe.
          return 0;
        }
        // `--name` sets BOTH the package.json name and the marketplace name: the marketplace name
        // is the identity that matters (must be unique across marketplaces), and tying the repo
        // name to it reads cleanly for a freshly scaffolded repo.
        await init(dir, {
          cliVersion: toolkitVersion(),
          ...(nameOpt !== undefined ? { name: nameOpt, marketplaceName: nameOpt } : {}),
        });
        const created = path.resolve(dir);
        out.write(`Created plugin repo at ${created}.\n`);
        out.write('Next: run `pnpm install`, then `aipm scaffold <name>` to add a plugin.\n');
        return 0;
      }

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
