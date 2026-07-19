/**
 * Subprocess UAT for `aipm lint`: spawns the built CLI (`dist/bin.js`) as a real user would,
 * asserting stdout/exit codes for every format (text/json/sarif) and every documented exit path
 * (spec §4.1: 0 clean, 1 errors present, 2 usage error). `aipm validate`'s own UAT suite
 * (`run.test.ts`) is unmodified — this file only adds coverage for the new `lint` command.
 *
 * Builds the CLI package (and `core`, via TS project references) once in `beforeAll` so the
 * subprocess runs the same compiled artifact a real install would, rather than calling `run()`
 * in-process.
 *
 * @see docs/specs/lint-engine.md §4.1
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init } from '@ai-plugin-marketplace/core';

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(CLI_DIR, 'dist', 'bin.js');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

interface JsonLintOutput {
  diagnostics: { ruleId: string; severity: string; legacyCode?: string; message: string }[];
  summary: { errorCount: number; fileCount: number };
}

interface SarifLintOutput {
  version: string;
  runs: {
    tool: { driver: { rules: { id: string }[] } };
    results: unknown[];
  }[];
}

let cleanRepo: string;
let brokenRepo: string;
let namelessRepo: string;

beforeAll(() => {
  // Real build: proves the wired `lint` command works from the compiled artifact, not just
  // against `run()` called in-process.
  execFileSync('pnpm', ['exec', 'tsc', '--build'], { cwd: CLI_DIR, stdio: 'inherit' });
}, 120_000);

beforeAll(async () => {
  cleanRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-lint-uat-clean-'));
  await init(cleanRepo, { cliVersion: '0.0.0' });

  brokenRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-lint-uat-broken-'));
  const pluginDir = path.join(brokenRepo, 'plugins', 'my-plugin');
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'aipm.config.ts'),
    "import { defineConfig } from '@ai-plugin-marketplace/core';\n" +
      "export default defineConfig({ version: '1.0.0', targets: ['claude'] });\n",
  );
  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'my-plugin', agents: './agents/missing.md' }, null, 2),
  );

  // #92 repro: a `plugin.json` that is valid JSON and a plain object, but omits the
  // schema-required `name` field. Also carries a second manifest-adjacent file (an agent) so
  // fileCount has more than one file to truthfully count.
  namelessRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-lint-uat-nameless-'));
  const namelessPluginDir = path.join(namelessRepo, 'plugins', 'p');
  fs.mkdirSync(path.join(namelessPluginDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(namelessPluginDir, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(namelessPluginDir, 'aipm.config.ts'),
    "import { defineConfig } from '@ai-plugin-marketplace/core';\n" +
      "export default defineConfig({ version: '1.0.0', targets: ['claude'] });\n",
  );
  fs.writeFileSync(
    path.join(namelessPluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ version: '0.1.0', description: 'missing its required name field' }, null, 2),
  );
  fs.writeFileSync(
    path.join(namelessPluginDir, 'agents', 'helper.md'),
    '---\nname: helper\ndescription: A helper agent\n---\n\nBody.\n',
  );
});

afterAll(() => {
  fs.rmSync(cleanRepo, { recursive: true, force: true });
  fs.rmSync(brokenRepo, { recursive: true, force: true });
  fs.rmSync(namelessRepo, { recursive: true, force: true });
});

describe('aipm lint (subprocess)', () => {
  it('exits 0 with no error diagnostics for a clean repo (default text format)', () => {
    const { code, stdout } = runCli(['lint', cleanRepo], cleanRepo);
    expect(code).toBe(0);
    expect(stdout).toContain('OK — no findings.');
  });

  it('exits 1 for a repo with a broken file reference (text format)', () => {
    const { code, stdout } = runCli(['lint', brokenRepo, '--format', 'text'], brokenRepo);
    expect(code).toBe(1);
    expect(stdout).toContain('correctness/broken-file-ref');
    expect(stdout).toContain('error');
  });

  it('--format json emits Diagnostic[] plus a summary envelope', () => {
    const { code, stdout } = runCli(['lint', brokenRepo, '--format', 'json'], brokenRepo);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as JsonLintOutput;
    expect(Array.isArray(parsed.diagnostics)).toBe(true);
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    expect(parsed.summary.errorCount).toBeGreaterThan(0);
  });

  it('--format sarif emits a SARIF 2.1.0 log with one rule entry per distinct rule id', () => {
    const { code, stdout } = runCli(['lint', brokenRepo, '--format', 'sarif'], brokenRepo);
    expect(code).toBe(1);
    const sarif = JSON.parse(stdout) as SarifLintOutput;
    expect(sarif.version).toBe('2.1.0');
    const run = sarif.runs[0];
    expect(run).toBeDefined();
    const ruleIds = run?.tool.driver.rules.map((r) => r.id) ?? [];
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    expect(run?.results.length ?? 0).toBeGreaterThan(0);
  });

  it("--verbose appends each diagnostic's docs URL in text format", () => {
    const { stdout } = runCli(['lint', brokenRepo, '--verbose'], brokenRepo);
    expect(stdout).toMatch(/\(https?:\/\/\S+\)/);
  });

  it('exits 2 for an unsupported --as mode', () => {
    const { code, stderr } = runCli(['lint', cleanRepo, '--as', 'claude-plugin'], cleanRepo);
    expect(code).toBe(2);
    expect(stderr).toContain('not supported yet');
  });

  it('exits 2 for an invalid --format value', () => {
    const { code, stderr } = runCli(['lint', cleanRepo, '--format', 'yaml'], cleanRepo);
    expect(code).toBe(2);
    expect(stderr).toContain('--format must be one of');
  });

  it('exits 2 for a malformed --rule value', () => {
    const { code, stderr } = runCli(['lint', cleanRepo, '--rule', 'not-a-kv-pair'], cleanRepo);
    expect(code).toBe(2);
    expect(stderr).toContain('<id>=<severity>');
  });

  it('exits 2 for an unknown --rule severity', () => {
    const { code, stderr } = runCli(
      ['lint', cleanRepo, '--rule', 'correctness/broken-file-ref=critical'],
      cleanRepo,
    );
    expect(code).toBe(2);
    expect(stderr).toContain('error|warn|info|off');
  });

  it('--rule <id>=off downgrades exit code from 1 to 0 once every present error-rule is silenced', () => {
    const baseline = runCli(['lint', brokenRepo, '--format', 'json'], brokenRepo);
    const baselineParsed = JSON.parse(baseline.stdout) as JsonLintOutput;
    const errorRuleIds = [
      ...new Set(
        baselineParsed.diagnostics.filter((d) => d.severity === 'error').map((d) => d.ruleId),
      ),
    ];
    expect(errorRuleIds.length).toBeGreaterThan(0);

    const overrideArgs = errorRuleIds.flatMap((id) => ['--rule', `${id}=off`]);
    const { code, stdout } = runCli(
      ['lint', brokenRepo, '--format', 'json', ...overrideArgs],
      brokenRepo,
    );
    expect(code).toBe(0);
    const overridden = JSON.parse(stdout) as JsonLintOutput;
    expect(overridden.diagnostics.some((d) => errorRuleIds.includes(d.ruleId))).toBe(false);
  });

  it('leaves `aipm validate` behavior unaffected by the new lint command', () => {
    const { code, stdout } = runCli(['validate', cleanRepo], cleanRepo);
    expect(code).toBe(0);
    expect(stdout).toContain('OK');
  });

  it('exits 2 when --rule is given with no value (e.g. immediately followed by another flag)', () => {
    const { code, stderr } = runCli(['lint', cleanRepo, '--rule', '--format', 'json'], cleanRepo);
    expect(code).toBe(2);
    expect(stderr).toContain('<id>=<severity>');
  });

  it('exits 2 when --rule is the last, valueless argument', () => {
    const { code, stderr } = runCli(['lint', cleanRepo, '--rule'], cleanRepo);
    expect(code).toBe(2);
    expect(stderr).toContain('<id>=<severity>');
  });

  it('exits 2 for a duplicate --format, never leaking the second value as the target path (regression)', () => {
    // Before the fix: only the first `--format`+value pair was consumed, so the second
    // `--format json` left its value token `json` unconsumed — the positional scanner then picked
    // `json` up as the target path and silently dropped `cleanRepo`, running lint against a
    // nonexistent `<cwd>/json` instead of erroring. Now it must be a clean usage error, never a
    // "path not found"-style failure.
    const { code, stderr } = runCli(
      ['lint', '--format', 'text', '--format', 'json', cleanRepo],
      cleanRepo,
    );
    expect(code).toBe(2);
    expect(stderr).toContain('--format may only be specified once');
    expect(stderr).not.toContain('ENOENT');
  });

  it('exits 2 for a duplicate --as', () => {
    const { code, stderr } = runCli(
      ['lint', '--as', 'aipm-repo', '--as', 'claude-plugin', cleanRepo],
      cleanRepo,
    );
    expect(code).toBe(2);
    expect(stderr).toContain('--as may only be specified once');
  });

  it("warns with a stable synthetic diagnostic when --rule targets a typo'd/unknown rule id (L-D6)", () => {
    const { code, stdout } = runCli(
      ['lint', brokenRepo, '--format', 'json', '--rule', 'correctness/borken-file-ref=off'],
      brokenRepo,
    );
    // The typo'd override matches nothing, so it neither silences anything nor blocks; the real
    // broken-file-ref error is still present and still fails the run.
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as JsonLintOutput;
    const unknownRuleDiagnostics = parsed.diagnostics.filter(
      (d) => d.ruleId === 'config/unknown-rule',
    );
    expect(unknownRuleDiagnostics).toHaveLength(1);
    expect(unknownRuleDiagnostics[0]?.severity).toBe('warn');
  });

  it('does NOT warn when --rule targets a valid registered rule id that produced nothing this run', () => {
    // Negative case for L-D6: a real rule id that simply had no diagnostics this run (clean repo)
    // must not be flagged as unknown.
    const { code, stdout } = runCli(
      ['lint', cleanRepo, '--format', 'json', '--rule', 'correctness/broken-file-ref=off'],
      cleanRepo,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as JsonLintOutput;
    expect(parsed.diagnostics.some((d) => d.ruleId === 'config/unknown-rule')).toBe(false);
  });

  // Regression coverage for #92's repro: `p/.claude-plugin/plugin.json` with `name` removed
  // (kept valid JSON) must fail `aipm lint`, with a diagnostic naming the missing field.
  it('exits 1 and reports a schema/target-conformance diagnostic when plugin.json is missing the required "name" field', () => {
    const { code, stdout } = runCli(['lint', namelessRepo, '--format', 'json'], namelessRepo);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as JsonLintOutput;
    const schemaDiagnostics = parsed.diagnostics.filter(
      (d) => d.ruleId === 'schema/target-conformance',
    );
    expect(schemaDiagnostics).toHaveLength(1);
    expect(schemaDiagnostics[0]?.severity).toBe('error');
    expect(schemaDiagnostics[0]?.legacyCode).toBe('schema-invalid');
    expect(schemaDiagnostics[0]?.message).toContain('name');
  });

  // Regression coverage for #92: `summary.fileCount` must reflect files actually scanned, not
  // stay pinned at an invariant (e.g. always 1) regardless of manifest mutations.
  it('reports a truthful summary.fileCount that changes when the set of scanned files changes', () => {
    const { stdout: namelessStdout } = runCli(
      ['lint', namelessRepo, '--format', 'json'],
      namelessRepo,
    );
    const namelessParsed = JSON.parse(namelessStdout) as JsonLintOutput;
    // Known fixture: plugin.json + agents/helper.md are the only files the scanning rules read.
    expect(namelessParsed.summary.fileCount).toBe(2);

    // brokenRepo has only plugin.json (its referenced agent file does not exist on disk, so it
    // is never actually read) — a different known fixture with a different scanned-file count,
    // proving fileCount tracks what each run actually scanned rather than staying pinned at an
    // invariant regardless of which manifest/fixture is linted (#92's repro).
    const { stdout: brokenStdout } = runCli(['lint', brokenRepo, '--format', 'json'], brokenRepo);
    const brokenParsed = JSON.parse(brokenStdout) as JsonLintOutput;
    expect(brokenParsed.summary.fileCount).toBe(1);
    expect(brokenParsed.summary.fileCount).not.toBe(namelessParsed.summary.fileCount);
  });
});
