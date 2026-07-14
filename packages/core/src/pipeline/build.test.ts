/**
 * Tests for the build orchestrator (`runBuild`) — §5.2, §5.4, §7.2, §10.5.
 *
 * These exercise the orchestration end-to-end against a synthesized plugin built from the real
 * template `skill-evaluator` plugin (see `test-support/synth-plugin.ts`). They assert:
 *   - dist bundles are byte-identical to the committed template oracle (sentinel-less, §4.3);
 *   - in-plugin hook JSONs carry the `_generated` JSON sentinel and strip to the transform output;
 *   - `BuildResult.artifacts` lists the right files with correct `target`/`source`;
 *   - the post-build validate (§5.4) surfaces envelope-adherence violations.
 *
 * Developer-machine-only: these depend on a local template checkout (the dist oracle is not
 * present in CI). They self-skip when the checkout is absent.
 *
 * @see docs/specs/architecture.md §5.2 (build phase), §5.4 (phase invariants), §4.3 (sentinels)
 * @see docs/specs/architecture.md §7.2 (mechanical transforms), §8.1 (BuildResult/GeneratedFile)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { convertClaudeHooksYamlToJson } from '../targets/claude/transform.js';
import { convertClaudeHooksYamlToCursorJson } from '../targets/cursor/transform.js';
import { convertClaudeHooksYamlToGeminiJson } from '../targets/gemini/transform.js';
import { computePluginHookArtifacts, runBuild } from './build.js';
import { hasSentinel, readSentinelSource, stripSentinel } from './sentinel.js';
import {
  ALL_SYNTH_TARGETS,
  ORACLE_GEMINI_DIR,
  ORACLE_KIRO_DIR,
  SYNTH_PLUGIN_NAME,
  synthPluginRepo,
} from '../test-support/synth-plugin.js';
import type { SynthRepo } from '../test-support/synth-plugin.js';
import { TEMPLATE_REPO_AVAILABLE } from '../test-support/template-repo.js';

const describeMaybe = TEMPLATE_REPO_AVAILABLE ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect every file under `dir`, relative to `dir`, sorted. */
function collectRelative(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const sub of collectRelative(path.join(dir, entry.name))) {
        out.push(path.join(entry.name, sub));
      }
    } else {
      out.push(entry.name);
    }
  }
  return out.sort();
}

/** Assert tree at `actualDir` is byte-identical to `oracleDir` (file set + contents). */
function expectByteIdentical(actualDir: string, oracleDir: string): void {
  const actual = collectRelative(actualDir);
  const expected = collectRelative(oracleDir);
  expect(actual).toStrictEqual(expected);
  for (const rel of actual) {
    const a = fs.readFileSync(path.join(actualDir, rel));
    const b = fs.readFileSync(path.join(oracleDir, rel));
    expect(a.equals(b), `byte mismatch for ${rel}`).toBe(true);
  }
}

// ---------------------------------------------------------------------------

describeMaybe('runBuild — dist parity with the committed oracle', () => {
  let repo: SynthRepo;
  afterEach(() => {
    repo.cleanup();
  });

  it('produces dist/gemini/<plugin>/ byte-identical to the oracle (sentinel-less)', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);
    const distGemini = path.join(repo.repoRoot, 'dist', 'gemini', SYNTH_PLUGIN_NAME);
    expectByteIdentical(distGemini, ORACLE_GEMINI_DIR);
  });

  it('produces dist/kiro/<plugin>/ byte-identical to the oracle (sentinel-less)', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);
    const distKiro = path.join(repo.repoRoot, 'dist', 'kiro', SYNTH_PLUGIN_NAME);
    expectByteIdentical(distKiro, ORACLE_KIRO_DIR);
  });

  it('never writes a _generated sentinel into the dist trees', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);
    const distGeminiExt = path.join(
      repo.repoRoot,
      'dist',
      'gemini',
      SYNTH_PLUGIN_NAME,
      'gemini-extension.json',
    );
    const content = fs.readFileSync(distGeminiExt, 'utf-8');
    expect(content.includes('_generated')).toBe(false);
  });
});

describeMaybe('runBuild — in-plugin hook JSON sentinels (§4.3)', () => {
  let repo: SynthRepo;
  afterEach(() => {
    repo.cleanup();
  });

  it('writes hooks/claude.json with a json-field sentinel that strips to the Claude transform', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);

    const claudeJsonPath = path.join(repo.pluginDir, 'hooks', 'claude.json');
    expect(fs.existsSync(claudeJsonPath)).toBe(true);

    const onDisk = fs.readFileSync(claudeJsonPath, 'utf-8');
    // §4.3: carries a json-field sentinel naming the author-authored source.
    expect(hasSentinel(onDisk, 'json-field')).toBe(true);
    expect(readSentinelSource(onDisk, 'json-field')).toBe('hooks/claude.yaml');

    // §7.2: stripping the sentinel yields exactly the mechanical Claude transform output.
    const yaml = fs.readFileSync(path.join(repo.pluginDir, 'hooks', 'claude.yaml'), 'utf-8');
    expect(stripSentinel(onDisk, 'json-field')).toBe(convertClaudeHooksYamlToJson(yaml));
  });

  it('writes hooks/hooks.json (gemini) with a json-field sentinel that strips to the Gemini transform', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);

    const hooksJsonPath = path.join(repo.pluginDir, 'hooks', 'hooks.json');
    expect(fs.existsSync(hooksJsonPath)).toBe(true);

    const onDisk = fs.readFileSync(hooksJsonPath, 'utf-8');
    expect(hasSentinel(onDisk, 'json-field')).toBe(true);
    expect(readSentinelSource(onDisk, 'json-field')).toBe('hooks/claude.yaml');

    const yaml = fs.readFileSync(path.join(repo.pluginDir, 'hooks', 'claude.yaml'), 'utf-8');
    expect(stripSentinel(onDisk, 'json-field')).toBe(convertClaudeHooksYamlToGeminiJson(yaml));
  });

  it('does NOT emit gemini hooks.json when gemini is absent from the envelope', async () => {
    repo = synthPluginRepo(['claude']);
    await runBuild(repo.pluginDir);
    expect(fs.existsSync(path.join(repo.pluginDir, 'hooks', 'hooks.json'))).toBe(false);
    // claude.json IS emitted because claude is declared.
    expect(fs.existsSync(path.join(repo.pluginDir, 'hooks', 'claude.json'))).toBe(true);
  });

  it('writes hooks/cursor.json (cursor) with a json-field sentinel that strips to the Cursor transform', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);

    const cursorJsonPath = path.join(repo.pluginDir, 'hooks', 'cursor.json');
    expect(fs.existsSync(cursorJsonPath)).toBe(true);

    const onDisk = fs.readFileSync(cursorJsonPath, 'utf-8');
    expect(hasSentinel(onDisk, 'json-field')).toBe(true);
    expect(readSentinelSource(onDisk, 'json-field')).toBe('hooks/claude.yaml');

    const yaml = fs.readFileSync(path.join(repo.pluginDir, 'hooks', 'claude.yaml'), 'utf-8');
    expect(stripSentinel(onDisk, 'json-field')).toBe(convertClaudeHooksYamlToCursorJson(yaml));
  });

  it('does NOT emit cursor.json when cursor is absent from the envelope', async () => {
    repo = synthPluginRepo(['claude']);
    await runBuild(repo.pluginDir);
    expect(fs.existsSync(path.join(repo.pluginDir, 'hooks', 'cursor.json'))).toBe(false);
  });
});

describeMaybe('runBuild — BuildResult shape (§8.1)', () => {
  let repo: SynthRepo;
  afterEach(() => {
    repo.cleanup();
  });

  it('returns a length-1 array for single-plugin input with the correct plugin name and dir', async () => {
    repo = synthPluginRepo(['claude', 'gemini']);
    const results = await runBuild(repo.pluginDir);
    expect(results).toHaveLength(1);
    expect(results[0]?.plugin).toBe(SYNTH_PLUGIN_NAME);
    expect(results[0]?.pluginDir).toBe(repo.pluginDir);
    expect(typeof results[0]?.durationMs).toBe('number');
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records the claude hook JSON with target=claude and the right source', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    const [result] = await runBuild(repo.repoRoot);

    const claudeArtifact = result?.artifacts.find(
      (a) => a.path === path.join(repo.pluginDir, 'hooks', 'claude.json'),
    );
    expect(claudeArtifact).toBeDefined();
    expect(claudeArtifact?.target).toBe('claude');
    expect(claudeArtifact?.source).toBe(`${SYNTH_PLUGIN_NAME}/hooks/claude.yaml`);
  });

  it('records dist gemini and kiro bundle files with the right target', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    const [result] = await runBuild(repo.repoRoot);
    const artifacts = result?.artifacts ?? [];

    const geminiExt = artifacts.find(
      (a) =>
        a.path ===
        path.join(repo.repoRoot, 'dist', 'gemini', SYNTH_PLUGIN_NAME, 'gemini-extension.json'),
    );
    expect(geminiExt?.target).toBe('gemini');

    const kiroPower = artifacts.find(
      (a) => a.path === path.join(repo.repoRoot, 'dist', 'kiro', SYNTH_PLUGIN_NAME, 'POWER.md'),
    );
    expect(kiroPower?.target).toBe('kiro');
  });

  it('records the cursor hook JSON with target=cursor and the right source', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    const [result] = await runBuild(repo.repoRoot);

    const cursorArtifact = result?.artifacts.find(
      (a) => a.path === path.join(repo.pluginDir, 'hooks', 'cursor.json'),
    );
    expect(cursorArtifact).toBeDefined();
    expect(cursorArtifact?.target).toBe('cursor');
    expect(cursorArtifact?.source).toBe(`${SYNTH_PLUGIN_NAME}/hooks/claude.yaml`);
  });

  it('emits only hooks/cursor.json for cursor (no dist tree) and nothing for vercel', async () => {
    repo = synthPluginRepo(['cursor', 'vercel']);
    const [result] = await runBuild(repo.pluginDir);
    // No dist trees: cursor/vercel have no bundle step.
    expect(fs.existsSync(path.join(repo.repoRoot, 'dist'))).toBe(false);
    // Neither claude nor gemini is declared → their hook JSONs are absent.
    expect(fs.existsSync(path.join(repo.pluginDir, 'hooks', 'claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(repo.pluginDir, 'hooks', 'hooks.json'))).toBe(false);
    // cursor IS declared and a hooks YAML is present → hooks/cursor.json is emitted.
    expect(fs.existsSync(path.join(repo.pluginDir, 'hooks', 'cursor.json'))).toBe(true);
    expect(result?.artifacts).toHaveLength(1);
    expect(result?.artifacts[0]?.target).toBe('cursor');
  });
});

describeMaybe('runBuild — post-build validation (§5.4)', () => {
  let repo: SynthRepo;
  afterEach(() => {
    repo.cleanup();
  });

  it('throws under failFast when an artifact exists for a target outside the envelope', async () => {
    // Declare only claude, but the plugin still carries gemini-extension.json etc. → adherence.
    repo = synthPluginRepo(['claude']);
    await expect(runBuild(repo.pluginDir, { failFast: true })).rejects.toThrow(
      /envelope-adherence/,
    );
  });

  it('without failFast, returns results even though post-build validation has hard findings', async () => {
    repo = synthPluginRepo(['claude']);
    // Should NOT throw — the CLI decides the exit code from a separate validate call.
    const results = await runBuild(repo.pluginDir);
    expect(results).toHaveLength(1);
  });

  it('a clean all-targets build passes post-build validation under failFast', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    // No throw means post-build validate found no hard findings.
    const results = await runBuild(repo.repoRoot, { failFast: true });
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// computePluginHookArtifacts — cursor branch (template-independent, §3.3/§4.3)
//
// This is the single source of truth shared by runBuild (writes) and the freshness check
// (compares on-disk bytes). Exercising it directly needs only a hand-written hooks/claude.yaml,
// so it runs in CI without the template checkout.
// ---------------------------------------------------------------------------

describe('computePluginHookArtifacts — cursor branch', () => {
  let pluginDir: string | undefined;

  afterEach(() => {
    // Guard the cleanup: if a test fails before `pluginDir` is assigned, an unguarded
    // `fs.existsSync(undefined)` throws `path must be a string` and masks the real failure.
    if (pluginDir && fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true });
  });

  /** Write a plugin dir containing hooks/claude.yaml and return its absolute path. */
  function writePluginWithHooks(yaml: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-cursor-hook-'));
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'claude.yaml'), yaml, 'utf-8');
    return dir;
  }

  const HOOKS_YAML =
    'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { type: command, command: ./guard.sh }\n';

  it('produces a hooks/cursor.json artifact (target cursor, json-field sentinel) when cursor is declared', () => {
    pluginDir = writePluginWithHooks(HOOKS_YAML);
    const artifacts = computePluginHookArtifacts(pluginDir, ['cursor']);

    const cursor = artifacts.find((a) => a.target === 'cursor');
    expect(cursor).toBeDefined();
    expect(cursor?.absPath).toBe(path.join(pluginDir, 'hooks', 'cursor.json'));
    expect(cursor?.source).toBe('hooks/claude.yaml');
    expect(cursor?.sentinelMode).toBe('json-field');
    // The sentinel-stripped body equals the mechanical Cursor transform output.
    expect(stripSentinel(cursor?.expectedContent ?? '', 'json-field')).toBe(
      convertClaudeHooksYamlToCursorJson(HOOKS_YAML),
    );
  });

  it('does not produce a cursor artifact when cursor is absent from the envelope', () => {
    pluginDir = writePluginWithHooks(HOOKS_YAML);
    const artifacts = computePluginHookArtifacts(pluginDir, ['claude']);
    expect(artifacts.some((a) => a.target === 'cursor')).toBe(false);
  });

  it('round-trips the generated cursor.json bytes byte-for-byte (freshness invariant §10.5)', () => {
    pluginDir = writePluginWithHooks(HOOKS_YAML);

    // First pass: compute + write (what runBuild does).
    const first = computePluginHookArtifacts(pluginDir, ['cursor']).find(
      (a) => a.target === 'cursor',
    );
    expect(first).toBeDefined();
    fs.writeFileSync(first?.absPath ?? '', first?.expectedContent ?? '', 'utf-8');

    // Second pass: recompute (what the freshness check does) and compare to the on-disk bytes.
    const second = computePluginHookArtifacts(pluginDir, ['cursor']).find(
      (a) => a.target === 'cursor',
    );
    const onDisk = fs.readFileSync(first?.absPath ?? '', 'utf-8');
    expect(second?.expectedContent).toBe(onDisk);
  });
});
