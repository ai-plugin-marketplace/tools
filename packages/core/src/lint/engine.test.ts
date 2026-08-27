/**
 * End-to-end test for the public `lint()` entry point: discovers a plugin under a repo root and
 * runs every rule against it, producing both migrated-legacy diagnostics (carrying `legacyCode`)
 * and new-rule diagnostics.
 *
 * @see docs/specs/lint-engine.md §4.1
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBuild } from '../pipeline/build.js';
import { runValidate } from '../pipeline/validate.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryRepo } from '../test-support/synth-plugin.js';
import { lint } from './engine.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-lint-engine-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function write(rel: string, content: string | object): void {
  const full = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    'utf-8',
  );
}

describe('lint()', () => {
  it('runs both migrated and new rules against a discovered plugin', async () => {
    write(
      'plugins/my-plugin/aipm.config.ts',
      `import { defineConfig } from '@ai-plugin-marketplace/core';\n` +
        `export default defineConfig({ version: '1.0.0', targets: ['claude'] });\n`,
    );
    // A manifest field referencing a nonexistent agent file — should surface both the legacy
    // schema-invalid-style path-existence check AND the new broken-file-ref rule.
    write('plugins/my-plugin/.claude-plugin/plugin.json', {
      name: 'my-plugin',
      agents: './agents/missing.md',
    });

    const result = await lint(repoRoot);

    // A migrated-legacy diagnostic (from the per-target schema/adherence rules) carries legacyCode.
    const legacyDiagnostics = result.diagnostics.filter((d) => d.legacyCode !== undefined);
    expect(legacyDiagnostics.length).toBeGreaterThan(0);

    // A new-rule diagnostic (broken-file-ref) has no legacyCode.
    const brokenRefDiagnostics = result.diagnostics.filter(
      (d) => d.ruleId === 'correctness/broken-file-ref',
    );
    expect(brokenRefDiagnostics).toHaveLength(1);
    expect(brokenRefDiagnostics[0]?.legacyCode).toBeUndefined();
    expect(brokenRefDiagnostics[0]?.message).toContain('./agents/missing.md');
  });

  it('is silent (no diagnostics) for a fully conformant single-target plugin', async () => {
    write(
      'plugins/clean-plugin/aipm.config.ts',
      `import { defineConfig } from '@ai-plugin-marketplace/core';\n` +
        `export default defineConfig({ version: '1.0.0', targets: ['claude'] });\n`,
    );
    write('plugins/clean-plugin/.claude-plugin/plugin.json', { name: 'clean-plugin' });
    write('.claude-plugin/marketplace.json', {
      name: 'test-marketplace',
      plugins: [{ name: 'clean-plugin', source: './plugins/clean-plugin' }],
    });

    const result = await lint(repoRoot);
    expect(result.diagnostics).toEqual([]);
  });

  // Regression coverage for #92: a `plugin.json` missing the required `name` field must produce
  // a lint diagnostic (mirroring `validateClaudePlugin`'s hard `schema-invalid` finding), not
  // silently pass.
  it('emits a schema-invalid-backed diagnostic when plugin.json is missing the required "name" field', async () => {
    write(
      'plugins/nameless-plugin/aipm.config.ts',
      `import { defineConfig } from '@ai-plugin-marketplace/core';\n` +
        `export default defineConfig({ version: '1.0.0', targets: ['claude'] });\n`,
    );
    write('plugins/nameless-plugin/.claude-plugin/plugin.json', {
      version: '0.1.0',
      description: 'A plugin manifest missing its required name field',
    });

    const result = await lint(repoRoot);

    const schemaDiagnostics = result.diagnostics.filter(
      (d) => d.ruleId === 'schema/target-conformance',
    );
    expect(schemaDiagnostics).toHaveLength(1);
    expect(schemaDiagnostics[0]).toMatchObject({
      severity: 'error',
      legacyCode: 'schema-invalid',
    });
    expect(schemaDiagnostics[0]?.message).toContain('name');
  });

  // Regression coverage for #92: `scannedFiles` (and therefore the CLI json format's
  // `summary.fileCount`) must reflect the files this run actually read, per
  // docs/specs/lint-engine.md §4.1's scan-scope definition — not a value derived from
  // diagnostics, which stays constant regardless of what was actually scanned.
  describe('scannedFiles (scan-scope tracking, #92)', () => {
    it('equals the real scanned-file count for a known fixture, and is unaffected by manifest content', async () => {
      write(
        'plugins/scan-target/aipm.config.ts',
        `import { defineConfig } from '@ai-plugin-marketplace/core';\n` +
          `export default defineConfig({ version: '1.0.0', targets: ['claude'] });\n`,
      );
      write('plugins/scan-target/.claude-plugin/plugin.json', {
        name: 'scan-target',
        agents: ['./agents/helper.md'],
      });
      write(
        'plugins/scan-target/agents/helper.md',
        '---\nname: helper\ndescription: A helper agent\n---\n\nBody.\n',
      );

      const result = await lint(repoRoot);

      // Known fixture: exactly plugin.json and agents/helper.md are read by the rules that scan
      // manifest/frontmatter content (broken-file-ref, frontmatter-parses, target-conformance).
      expect(result.scannedFiles).toEqual([
        'plugins/scan-target/.claude-plugin/plugin.json',
        'plugins/scan-target/agents/helper.md',
      ]);

      // Every entry must be `/`-separated (never `path.sep`, which is `\` on Windows) — matching
      // `Diagnostic.file`'s repo-relative, `/`-joined convention (L-D1) so the two are directly
      // comparable and the output is deterministic across platforms.
      for (const rel of result.scannedFiles) {
        expect(rel).toContain('/');
        expect(rel).not.toContain('\\');
      }

      // Mutating the manifest (removing the required `name` field, per #92's repro) must not
      // change the scanned-file count — this is the invariant-1 bug: fileCount must track what
      // was actually read, not stay pinned regardless of manifest mutations.
      write('plugins/scan-target/.claude-plugin/plugin.json', {
        // `name` removed
        agents: ['./agents/helper.md'],
      });
      const secondRun = await lint(repoRoot);
      expect(secondRun.scannedFiles).toHaveLength(2);
      expect(secondRun.scannedFiles).toEqual(result.scannedFiles);
    });

    it('does not count files that exist on disk but no active rule reads', async () => {
      write(
        'plugins/scan-target/aipm.config.ts',
        `import { defineConfig } from '@ai-plugin-marketplace/core';\n` +
          `export default defineConfig({ version: '1.0.0', targets: ['claude'] });\n`,
      );
      write('plugins/scan-target/.claude-plugin/plugin.json', { name: 'scan-target' });
      // A stray file no rule's candidate-file list includes.
      write('plugins/scan-target/NOTES.md', '# scratch notes, not a scanned artifact\n');

      const result = await lint(repoRoot);

      expect(result.scannedFiles).not.toContain('plugins/scan-target/NOTES.md');
      expect(result.scannedFiles).toContain('plugins/scan-target/.claude-plugin/plugin.json');
    });
  });

  describe('cross-target consistency gating (matches validate())', () => {
    let repo: SynthRegistryRepo | undefined;

    afterEach(() => {
      repo?.cleanup();
    });

    it('does not double-report marketplace-registration when registry generation is opted in', async () => {
      // Multi-target (so the cross-target step that would run marketplace-registration is
      // reached) with an `aipm.workspace.ts` (registry generation opted in) — mirrors
      // `pipeline/registry-codegen.test.ts`'s "does NOT also emit marketplace-registration when
      // generation is opted in" test for `validate()`, proving `lint()` applies the identical
      // gating (§10.1 step 4 comment in `pipeline/validate.ts`: "design spec, locked decision 2").
      repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude', 'cursor'] }], { name: 'm' });
      await runBuild(repo.repoRoot); // generates the registries, so they start out fresh

      const result = await lint(repo.repoRoot);

      // The hand-authored-registry check must be skipped entirely...
      const marketplaceRegistrationDiagnostics = result.diagnostics.filter(
        (d) => d.ruleId === 'correctness/marketplace-registration',
      );
      expect(marketplaceRegistrationDiagnostics).toEqual([]);

      // ...while the registry-freshness rule (which owns registry correctness in this mode) still
      // ran and found the freshly-built registries fresh — proving this isn't just "no rules ran
      // at all" but the specific intended gating.
      const freshnessDiagnostics = result.diagnostics.filter((d) => d.legacyCode === 'freshness');
      expect(freshnessDiagnostics).toEqual([]);
    });

    it('still runs marketplace-registration (hand-authored path) when no workspace is present', async () => {
      // Same multi-target shape but WITHOUT a workspace (registry generation not opted in) — the
      // historical hand-authored-registry check must still fire when the plugin isn't listed
      // anywhere, proving the gate is genuinely conditional on workspace presence and not always
      // skipping this rule.
      repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude', 'cursor'] }]); // no workspace
      await runBuild(repo.repoRoot);

      const result = await lint(repo.repoRoot);
      const marketplaceRegistrationDiagnostics = result.diagnostics.filter(
        (d) => d.ruleId === 'correctness/marketplace-registration',
      );
      expect(marketplaceRegistrationDiagnostics.length).toBeGreaterThan(0);
    });
  });
});

// Regression coverage for #101: #91 made `runValidate` (hard `envelope-invalid`) and `runBuild`
// (thrown `ConfigLoadError`) catch a plugin-shaped directory missing `aipm.config.ts`, but `lint()`
// stayed silent for the identical tree. `lint` and `validate` must agree on this case.
describe('lint() — plugin-shaped repo-root subdirectory missing aipm.config.ts (#91, #101)', () => {
  it('agrees with runValidate(): both report the equivalent envelope-invalid finding for the same tree', async () => {
    // Repro shape from #91: a plugins/* dir with a target manifest but no aipm.config.ts.
    write('plugins/broken/.claude-plugin/plugin.json', { name: 'broken', version: '0.1.0' });

    const [lintResult, validateResult] = await Promise.all([lint(repoRoot), runValidate(repoRoot)]);

    // validate() surfaces its existing hard envelope-invalid finding (unchanged by this fix, #91).
    const envelopeFindings = validateResult.findings.filter((f) => f.code === 'envelope-invalid');
    expect(envelopeFindings).toHaveLength(1);
    expect(envelopeFindings[0]?.plugin).toBe('broken');
    expect(envelopeFindings[0]?.severity).toBe('hard');
    expect(validateResult.passed).toBe(false);

    // lint() must now surface the equivalent diagnostic — same rule as a malformed config
    // (`schema/envelope-shape`), `error` severity (validate's `hard` maps to lint's `error`,
    // L-D2's findingToDiagnostic), carrying the legacy `envelope-invalid` code, and the identical
    // message validate reports — not silent, as it was pre-fix.
    const lintEnvelopeDiagnostics = lintResult.diagnostics.filter(
      (d) => d.legacyCode === 'envelope-invalid',
    );
    expect(lintEnvelopeDiagnostics).toHaveLength(1);
    expect(lintEnvelopeDiagnostics[0]).toMatchObject({
      ruleId: 'schema/envelope-shape',
      category: 'schema',
      severity: 'error',
      file: 'broken',
    });
    expect(lintEnvelopeDiagnostics[0]?.message).toBe(envelopeFindings[0]?.message);
  });

  it('emits nothing further beyond the envelope-invalid diagnostic for the config-less plugin', async () => {
    // No other rule can run without a resolved envelope (engine.ts's `continue` after the failed
    // loadPluginConfig call) — mirroring validate()'s short-circuit on an unusable envelope.
    write('plugins/broken/.claude-plugin/plugin.json', { name: 'broken', version: '0.1.0' });

    const result = await lint(repoRoot);

    expect(result.diagnostics.filter((d) => d.file === 'broken')).toHaveLength(1);
  });
});

// #101, follow-on: the same lint/validate disagreement exists for an `aipm.config.ts` that is
// present but cannot be imported (syntax error, no usable default export). `runValidate` reports
// a hard `envelope-invalid` for it; `lint()` previously returned no diagnostic at all, so a
// syntax-broken envelope still got a clean bill of health from `lint`.
describe('lint() — plugin whose aipm.config.ts exists but fails to import (#101)', () => {
  it('agrees with runValidate(): both report the equivalent envelope-invalid for an unparseable config', async () => {
    write('plugins/broken/.claude-plugin/plugin.json', { name: 'broken', version: '0.1.0' });
    // Deliberately unparseable TypeScript — the transpile/import step throws, so the failure
    // never reaches the envelope schema and is not a ZodError.
    write('plugins/broken/aipm.config.ts', 'export default {{{ not valid typescript\n');

    const [lintResult, validateResult] = await Promise.all([lint(repoRoot), runValidate(repoRoot)]);

    const envelopeFindings = validateResult.findings.filter((f) => f.code === 'envelope-invalid');
    expect(envelopeFindings).toHaveLength(1);
    expect(envelopeFindings[0]?.plugin).toBe('broken');
    expect(envelopeFindings[0]?.severity).toBe('hard');
    expect(validateResult.passed).toBe(false);

    const lintEnvelopeDiagnostics = lintResult.diagnostics.filter(
      (d) => d.legacyCode === 'envelope-invalid',
    );
    expect(lintEnvelopeDiagnostics).toHaveLength(1);
    expect(lintEnvelopeDiagnostics[0]).toMatchObject({
      ruleId: 'schema/envelope-shape',
      category: 'schema',
      severity: 'error',
      file: 'broken',
    });
    // Byte-identical to validate's: both take the ConfigLoadError's own message.
    expect(lintEnvelopeDiagnostics[0]?.message).toBe(envelopeFindings[0]?.message);
  });

  it('still reports the schema-violation case as per-issue envelope-invalid diagnostics', async () => {
    // A config that imports cleanly but violates the envelope schema stays on the ZodError path,
    // which expands into one diagnostic per issue rather than a single loader-message diagnostic.
    write('plugins/broken/.claude-plugin/plugin.json', { name: 'broken', version: '0.1.0' });
    write(
      'plugins/broken/aipm.config.ts',
      "import { defineConfig } from '@ai-plugin-marketplace/core';\n" +
        "export default defineConfig({ version: 'not-semver', targets: ['not-a-target'] });\n",
    );

    const result = await lint(repoRoot);

    const envelopeDiagnostics = result.diagnostics.filter(
      (d) => d.legacyCode === 'envelope-invalid',
    );
    expect(envelopeDiagnostics.length).toBeGreaterThan(0);
    for (const d of envelopeDiagnostics) {
      expect(d.ruleId).toBe('schema/envelope-shape');
      expect(d.severity).toBe('error');
      expect(d.message).toMatch(/^Invalid aipm\.config: \[/);
    }
  });
});
