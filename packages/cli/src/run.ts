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
 *   aipm lint [path]
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
  applyRuleSeverityOverrides,
  build,
  checkSupport,
  init,
  lint,
  listTargets,
  migrate,
  refreshScaffold,
  registeredRuleIds,
  scaffold,
  unknownRuleOverrideDiagnostics,
  validate,
} from '@ai-plugin-marketplace/core';
import type {
  AddTargetOutcome,
  Diagnostic,
  Finding,
  RefreshOutcome,
  RuleSeverityOverride,
  SupportReport,
  TargetId,
  ValidationResult,
} from '@ai-plugin-marketplace/core';
import { buildLintJson, buildLintSarif, formatLintText, lintExitCode } from './lint-format.js';
import type { LintFormat } from './lint-format.js';

interface RunOptions {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

const HELP = `aipm — AI plugin marketplace toolkit

Usage:
  aipm <command> [arguments]

Commands:
  init [dir]                    Scaffold a new plugin repo (default: cwd)
  init --name <name> [dir]      Scaffold a new plugin repo with an explicit marketplace/package name
  init --refresh [dir]          Update toolkit-owned scaffold files in an existing repo
  build [path]                  Build plugin artifacts (default: cwd)
                                (refuses to run with a toolkit older than the one that generated
                                existing artifacts; see --force-downgrade)
  validate [path]               Run validators on plugins (default: cwd)
  lint [path]                   Run the lint engine on plugins (default: cwd)
  scaffold <name>               Create a new plugin from templates
  migrate [path]                Apply schema migrations (no-op in this version)
  check-support <plugin>        Diagnose a plugin's target support envelope
  add-target <plugin> <target>  Scaffold target-specific files for a plugin
  list-targets                  List target IDs this toolkit knows about

Options:
  --name <name>                 With init: sets the new repo's marketplace name AND package name
                                (default marketplace name: $USER-ai-plugins).
                                Must be unique across marketplaces.
  --refresh                     With init: refresh an existing repo instead of creating one
  --force                       With init --refresh: overwrite locally-modified scaffold files
  --force-downgrade             With build: proceed even when the installed toolkit is older than
                                the version that generated existing artifacts (restamps with it)
  --as <mode>                   With lint: discovery mode (only 'aipm-repo' is supported today)
  --format <text|json|sarif>    With lint: output format (default: text)
  --rule <id>=<severity>        With lint: override a rule's severity (error|warn|info|off);
                                repeatable
  --verbose                     With lint --format text: append each diagnostic's docs URL
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
 * Extract every occurrence of a `--flag <value>` option from an argument list (supports both
 * `--flag value` and `--flag=value` per occurrence). Always consumes every matching token —
 * including a flag occurrence with no following value — regardless of how many times the flag
 * appears: a caller expecting at most one value still needs every occurrence's tokens consumed,
 * or a second/dangling occurrence's value token leaks through as an unconsumed positional argument
 * (the `lint` case below treats more than one `--format`/`--as` as a usage error precisely to
 * catch this, rather than silently dropping the second value and misreading it as the target
 * path). `missingValueIndices` records occurrences with no following value token at all — the
 * flag was last on the command line, or immediately followed by another flag — so callers that
 * require a value (e.g. `--rule`) can treat that as a usage error instead of silently ignoring
 * the flag. `--flag=` (empty string after `=`) is a deliberate, explicit empty value, not a
 * missing one — it is pushed to `values` as `''` so a caller can still reject it on its own terms
 * (e.g. `init --name=` fails downstream because an empty name is invalid, not because parsing
 * treated it as absent).
 */
function takeOptionValues(
  args: readonly string[],
  flag: string,
): { values: string[]; consumed: Set<number>; missingValueIndices: number[] } {
  const consumed = new Set<number>();
  const values: string[] = [];
  const missingValueIndices: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === flag) {
      consumed.add(i);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        consumed.add(i + 1);
        values.push(next);
      } else {
        missingValueIndices.push(i);
      }
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      consumed.add(i);
      values.push(arg.slice(flag.length + 1));
    }
  }
  return { values, consumed, missingValueIndices };
}

const RULE_SEVERITIES = new Set<RuleSeverityOverride>(['error', 'warn', 'info', 'off']);
const LINT_FORMATS = new Set<LintFormat>(['text', 'json', 'sarif']);

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

/**
 * Report the outcome of `aipm add-target` (§6.4). Preserve-or-warn: `already-present` and
 * `partially-added` are reported as informational, not errors — add-target never overwrites an
 * existing file (issue #90), so a file already being there is never a failure.
 */
function reportAddTarget(
  outcome: AddTargetOutcome,
  plugin: string,
  out: NodeJS.WritableStream,
): void {
  const { target, status, written, preserved } = outcome;
  switch (status) {
    case 'already-present': {
      out.write(
        `'${target}' is already present in ${plugin} (${preserved.join(', ')}); nothing to do.\n`,
      );
      break;
    }
    case 'added': {
      out.write(`Added '${target}' to ${plugin}: ${written.join(', ')}.\n`);
      break;
    }
    case 'partially-added': {
      out.write(`Added '${target}' to ${plugin}: ${written.join(', ')}.\n`);
      out.write(
        `  preserved existing file(s), left untouched: ${preserved.join(', ')}.\n` +
          '  Review them by hand if they need updating for this target.\n',
      );
      break;
    }
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

  // `-h`/`--help` must short-circuit to usage for every subcommand, before any argument parsing
  // or side effect: without this check, e.g. `aipm build --help` ran a real build, and
  // `aipm validate --help` misparsed `--help` as a path (issue #95). Checked ahead of the
  // `switch` below so it applies uniformly to every command, present and future, rather than
  // requiring each case to remember its own check.
  if (rest.includes('--help') || rest.includes('-h')) {
    out.write(HELP);
    return 0;
  }

  try {
    switch (command) {
      case 'init': {
        const refresh = rest.includes('--refresh');
        const force = rest.includes('--force');
        const { values: nameValues, consumed: nameConsumed } = takeOptionValues(rest, '--name');
        const nameOpt = nameValues[0];
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
        const outcome = await init(dir, {
          cliVersion: toolkitVersion(),
          ...(nameOpt !== undefined ? { name: nameOpt, marketplaceName: nameOpt } : {}),
        });
        const created = path.resolve(dir);
        out.write(`Created plugin repo at ${created}.\n`);
        // Issue #96: an ancestor pnpm-workspace.yaml means a `pnpm install` from `created` can be
        // swept into that ancestor's workspace (shared lockfile/hoisting) instead of staying
        // local. Warn before telling the user to install, so they can move/isolate first.
        if (outcome.ancestorWorkspace !== undefined) {
          err.write(
            `Warning: found an ancestor pnpm workspace at ${outcome.ancestorWorkspace}.\n` +
              `  Running 'pnpm install' inside ${created} may be swept into that ancestor\n` +
              '  workspace (shared lockfile/hoisting) instead of staying local to this repo.\n' +
              '  If that is not what you want, move this repo outside the ancestor workspace,\n' +
              "  or add it to the ancestor's pnpm-workspace.yaml `packages` list deliberately.\n",
          );
        }
        out.write(
          'Next: run `pnpm install`, then `pnpm exec aipm scaffold <name>` to add a plugin.\n',
        );
        return 0;
      }

      case 'build': {
        const forceDowngrade = rest.includes('--force-downgrade');
        // Resolve the target from the first non-flag positional so `aipm build --force-downgrade`
        // does not mistake the flag for a path.
        const target = rest.find((a) => !a.startsWith('-')) ?? process.cwd();
        const results = await build(target, { forceDowngrade });
        const artifactCount = results.reduce((n, r) => n + r.artifacts.length, 0);
        // §5.4: build runs validate before reporting success. The success summary is written
        // only when validate passes — printing it unconditionally would put a "Built N
        // plugin(s)" line ABOVE a hard finding that fails the run, misleading the user into
        // thinking the run succeeded (issue #97).
        const result = await validate(target);
        if (result.passed) {
          out.write(
            `Built ${String(results.length)} plugin(s), ${String(artifactCount)} artifact(s).\n`,
          );
        }
        const passed = reportValidation(result, out);
        return passed ? 0 : 1;
      }

      case 'validate': {
        const target = rest[0] ?? process.cwd();
        const result = await validate(target);
        const passed = reportValidation(result, out);
        return passed ? 0 : 1;
      }

      case 'lint': {
        // --as/--format take at most one value: a duplicate is a usage error rather than
        // silently keeping the first occurrence, which would otherwise leave the second
        // occurrence's *value* token unconsumed for the positional-path scan below to
        // misinterpret as the target path (see takeOptionValues's doc comment).
        const { values: asValues, consumed: asConsumed } = takeOptionValues(rest, '--as');
        if (asValues.length > 1) {
          err.write(
            `aipm: lint --as may only be specified once (got ${String(asValues.length)}).\n`,
          );
          return 2;
        }

        const { values: formatValues, consumed: formatConsumed } = takeOptionValues(
          rest,
          '--format',
        );
        if (formatValues.length > 1) {
          err.write(
            `aipm: lint --format may only be specified once (got ${String(formatValues.length)}).\n`,
          );
          return 2;
        }

        const {
          values: ruleOpts,
          consumed: ruleConsumed,
          missingValueIndices: ruleMissingValueIndices,
        } = takeOptionValues(rest, '--rule');
        if (ruleMissingValueIndices.length > 0) {
          err.write('aipm: lint --rule requires a value of the form <id>=<severity>.\n');
          return 2;
        }

        const verbose = rest.includes('--verbose');

        // §4.1/non-goals: only 'aipm-repo' discovery is implemented; foreign modes are issue 3.
        const asMode = asValues[0] ?? 'aipm-repo';
        if (asMode !== 'aipm-repo') {
          err.write(
            `aipm: lint --as '${asMode}' is not supported yet; only 'aipm-repo' is available.\n`,
          );
          return 2;
        }

        const format = (formatValues[0] ?? 'text') as LintFormat;
        if (!LINT_FORMATS.has(format)) {
          err.write(`aipm: lint --format must be one of text|json|sarif, got '${format}'.\n`);
          return 2;
        }

        const overrides = new Map<string, RuleSeverityOverride>();
        for (const raw of ruleOpts) {
          const eq = raw.indexOf('=');
          if (eq <= 0) {
            err.write(`aipm: lint --rule '${raw}' must be of the form <id>=<severity>.\n`);
            return 2;
          }
          const ruleId = raw.slice(0, eq);
          const severity = raw.slice(eq + 1);
          if (!RULE_SEVERITIES.has(severity as RuleSeverityOverride)) {
            err.write(`aipm: lint --rule '${raw}': severity must be one of error|warn|info|off.\n`);
            return 2;
          }
          overrides.set(ruleId, severity as RuleSeverityOverride);
        }

        const consumed = new Set<number>([...asConsumed, ...formatConsumed, ...ruleConsumed]);
        const target =
          rest.find((arg, i) => !arg.startsWith('-') && !consumed.has(i)) ?? process.cwd();

        const result = await lint(target);
        // L-D6: an unrecognized --rule ruleId (typo) is itself a warn diagnostic, checked against
        // both this run's diagnostics and the full registry — see the function's doc comment for
        // why it must run against result.diagnostics BEFORE applyRuleSeverityOverrides.
        const unknownRuleDiagnostics = unknownRuleOverrideDiagnostics(
          overrides,
          result.diagnostics,
          registeredRuleIds(),
        );
        const diagnostics: Diagnostic[] = [
          ...applyRuleSeverityOverrides(result.diagnostics, overrides),
          ...unknownRuleDiagnostics,
        ];
        const exitCode = lintExitCode(diagnostics);

        if (format === 'json') {
          out.write(
            `${JSON.stringify(buildLintJson(diagnostics, result.scannedFiles.length), null, 2)}\n`,
          );
        } else if (format === 'sarif') {
          out.write(`${JSON.stringify(buildLintSarif(diagnostics, toolkitVersion()), null, 2)}\n`);
        } else {
          out.write(`${formatLintText(diagnostics, { verbose })}\n`);
        }
        return exitCode;
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
        const outcome = await addTarget(resolvePluginDir(plugin), target as TargetId);
        reportAddTarget(outcome, plugin, out);
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
