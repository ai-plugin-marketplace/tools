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

import { PAYLOAD_ADAPTER_FILENAME, PAYLOAD_ADAPTER_SOURCE } from '../hooks/payload-adapter.js';
import { convertClaudeHooksYamlToJson } from '../targets/claude/transform.js';
import { convertClaudeHooksYamlToCursorJson } from '../targets/cursor/transform.js';
import { CURSOR_SHIM_FILENAME, CURSOR_SHIM_RUNNER_SOURCE } from '../targets/cursor/shim-runner.js';
import { convertClaudeHooksYamlToGeminiJson } from '../targets/gemini/transform.js';
import { computePluginHookArtifacts, runBuild } from './build.js';
import {
  hasSentinel,
  readSentinelSource,
  sidecarContent,
  sidecarPath,
  stripSentinel,
} from './sentinel.js';
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
    // A hooks YAML is present regardless of envelope → the payload adapter + its sidecar are
    // always emitted alongside cursor.json (docs/specs/payload-adapter.md §11, D10).
    expect(fs.existsSync(path.join(repo.pluginDir, 'hooks', 'payload-adapter'))).toBe(true);
    expect(fs.existsSync(path.join(repo.pluginDir, 'hooks', 'payload-adapter.generated'))).toBe(
      true,
    );
    expect(result?.artifacts).toHaveLength(3);
    const cursorArtifact = result?.artifacts.find((a) => a.path.endsWith('cursor.json'));
    expect(cursorArtifact?.target).toBe('cursor');
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

    // Find by absPath, not target: with `claude` absent from the envelope, the shared
    // payload-adapter artifacts also fall back to `target: 'cursor'` (the only envelope target),
    // so `target === 'cursor'` alone would ambiguously match either artifact.
    const cursor = artifacts.find(
      (a) => a.absPath === path.join(pluginDir, 'hooks', 'cursor.json'),
    );
    expect(cursor).toBeDefined();
    expect(cursor?.target).toBe('cursor');
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
    const cursorJsonAbsPath = path.join(pluginDir, 'hooks', 'cursor.json');

    // Find by absPath, not target: with `claude` absent from the envelope, the shared
    // payload-adapter artifacts also fall back to `target: 'cursor'`, so a target-only predicate
    // would ambiguously match the payload-adapter artifact instead of cursor.json.

    // First pass: compute + write (what runBuild does).
    const first = computePluginHookArtifacts(pluginDir, ['cursor']).find(
      (a) => a.absPath === cursorJsonAbsPath,
    );
    expect(first).toBeDefined();
    fs.writeFileSync(first?.absPath ?? '', first?.expectedContent ?? '', 'utf-8');

    // Second pass: recompute (what the freshness check does) and compare to the on-disk bytes.
    const second = computePluginHookArtifacts(pluginDir, ['cursor']).find(
      (a) => a.absPath === cursorJsonAbsPath,
    );
    const onDisk = fs.readFileSync(first?.absPath ?? '', 'utf-8');
    expect(second?.expectedContent).toBe(onDisk);
  });
});

// ---------------------------------------------------------------------------
// computePluginHookArtifacts — cursor controller-hook shim artifacts
// (template-independent; cursor-controller-shim.md §3.3/§3.4)
// ---------------------------------------------------------------------------

describe('computePluginHookArtifacts — cursor shim artifacts', () => {
  let pluginDir: string | undefined;

  afterEach(() => {
    if (pluginDir && fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true });
  });

  function writePluginWithHooks(yaml: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-cursor-shim-build-'));
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'claude.yaml'), yaml, 'utf-8');
    return dir;
  }

  // A gating (PreToolUse) source → the shim files must be emitted alongside cursor.json.
  const GATING_YAML =
    'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { type: command, command: ./gate.sh }\n';
  // An observer-only (PostToolUse) source → no shim files.
  const OBSERVER_YAML =
    'hooks:\n  PostToolUse:\n    - matcher: Write\n      hooks:\n        - { type: command, command: ./log.sh }\n';

  it('emits cursor.json + cursor-shim.mjs + the .generated sidecar for a gating source (§3.3)', () => {
    pluginDir = writePluginWithHooks(GATING_YAML);
    const artifacts = computePluginHookArtifacts(pluginDir, ['cursor']);
    const shimAbs = path.join(pluginDir, 'hooks', CURSOR_SHIM_FILENAME);

    const cursorJson = artifacts.find(
      (a) => a.absPath === path.join(pluginDir, 'hooks', 'cursor.json'),
    );
    const shim = artifacts.find((a) => a.absPath === shimAbs);
    const sidecar = artifacts.find((a) => a.absPath === sidecarPath(shimAbs));

    expect(cursorJson).toBeDefined();

    // The static runner is emitted byte-exact, target cursor, sidecar carrier.
    expect(shim).toBeDefined();
    expect(shim?.target).toBe('cursor');
    expect(shim?.sentinelMode).toBe('sidecar');
    expect(shim?.expectedContent).toBe(CURSOR_SHIM_RUNNER_SOURCE);

    // The sidecar carries the sentinel (the .mjs is pure JS); it names the author-authored source.
    expect(sidecar).toBeDefined();
    expect(sidecar?.absPath).toBe(`${shimAbs}.generated`);
    expect(sidecar?.expectedContent).toBe(sidecarContent('hooks/claude.yaml'));
    expect(hasSentinel(sidecar?.expectedContent ?? '', 'sidecar')).toBe(true);
    expect(readSentinelSource(sidecar?.expectedContent ?? '', 'sidecar')).toBe('hooks/claude.yaml');
  });

  it('emits NO shim files for an observer-only source (§3.3)', () => {
    pluginDir = writePluginWithHooks(OBSERVER_YAML);
    const artifacts = computePluginHookArtifacts(pluginDir, ['cursor']);
    const shimAbs = path.join(pluginDir, 'hooks', CURSOR_SHIM_FILENAME);

    // cursor.json is still emitted, but neither the runner nor its sidecar.
    expect(artifacts.some((a) => a.absPath === path.join(pluginDir, 'hooks', 'cursor.json'))).toBe(
      true,
    );
    expect(artifacts.some((a) => a.absPath === shimAbs)).toBe(false);
    expect(artifacts.some((a) => a.absPath === sidecarPath(shimAbs))).toBe(false);
  });

  it('round-trips all five artifacts byte-for-byte (freshness invariant §10.5)', () => {
    pluginDir = writePluginWithHooks(GATING_YAML);

    // First pass: compute + write (runBuild).
    for (const artifact of computePluginHookArtifacts(pluginDir, ['cursor'])) {
      fs.mkdirSync(path.dirname(artifact.absPath), { recursive: true });
      fs.writeFileSync(artifact.absPath, artifact.expectedContent, 'utf-8');
    }

    // Second pass: recompute (freshness) and compare to the on-disk bytes for each artifact.
    // cursor.json + cursor-shim.mjs + its sidecar + the payload adapter + its sidecar.
    const second = computePluginHookArtifacts(pluginDir, ['cursor']);
    expect(second).toHaveLength(5);
    for (const artifact of second) {
      const onDisk = fs.readFileSync(artifact.absPath, 'utf-8');
      expect(onDisk, `byte mismatch for ${path.basename(artifact.absPath)}`).toBe(
        artifact.expectedContent,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// computePluginHookArtifacts — payload adapter emission (template-independent;
// docs/specs/payload-adapter.md §11, D10)
// ---------------------------------------------------------------------------

describe('computePluginHookArtifacts — payload adapter', () => {
  let pluginDir: string | undefined;

  afterEach(() => {
    if (pluginDir && fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true });
  });

  function writePluginWithHooks(yaml: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-payload-adapter-build-'));
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'claude.yaml'), yaml, 'utf-8');
    return dir;
  }

  const HOOKS_YAML =
    'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { type: command, command: ./guard.sh }\n';

  it('emits hooks/payload-adapter + its .generated sidecar for any declared envelope (§11, D10)', () => {
    pluginDir = writePluginWithHooks(HOOKS_YAML);
    const adapterAbs = path.join(pluginDir, 'hooks', PAYLOAD_ADAPTER_FILENAME);

    for (const envelope of [['claude'], ['cursor'], ['gemini'], ['claude', 'cursor', 'gemini']]) {
      const artifacts = computePluginHookArtifacts(
        pluginDir,
        envelope as ('claude' | 'cursor' | 'gemini')[],
      );
      const adapter = artifacts.find((a) => a.absPath === adapterAbs);
      const sidecar = artifacts.find((a) => a.absPath === sidecarPath(adapterAbs));

      expect(adapter, `envelope ${envelope.join(',')}`).toBeDefined();
      expect(adapter?.sentinelMode).toBe('sidecar');
      // Byte-exact static asset — identical regardless of envelope (D10: takes no plugin-specific
      // argument).
      expect(adapter?.expectedContent).toBe(PAYLOAD_ADAPTER_SOURCE);

      expect(sidecar, `envelope ${envelope.join(',')}`).toBeDefined();
      expect(sidecar?.absPath).toBe(`${adapterAbs}.generated`);
      expect(sidecar?.expectedContent).toBe(sidecarContent('hooks/claude.yaml'));
      expect(hasSentinel(sidecar?.expectedContent ?? '', 'sidecar')).toBe(true);
      expect(readSentinelSource(sidecar?.expectedContent ?? '', 'sidecar')).toBe(
        'hooks/claude.yaml',
      );
    }
  });

  it('emits neither hooks/payload-adapter nor its sidecar when no hooks YAML exists', () => {
    pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-payload-adapter-nohooks-'));
    const artifacts = computePluginHookArtifacts(pluginDir, ['claude', 'cursor', 'gemini']);
    expect(artifacts).toHaveLength(0);
  });

  it('round-trips the generated payload-adapter + sidecar bytes byte-for-byte (freshness §10.5)', () => {
    pluginDir = writePluginWithHooks(HOOKS_YAML);

    const first = computePluginHookArtifacts(pluginDir, ['claude']);
    for (const artifact of first) {
      fs.mkdirSync(path.dirname(artifact.absPath), { recursive: true });
      fs.writeFileSync(artifact.absPath, artifact.expectedContent, 'utf-8');
    }

    const second = computePluginHookArtifacts(pluginDir, ['claude']);
    const adapterAbs = path.join(pluginDir, 'hooks', PAYLOAD_ADAPTER_FILENAME);
    const adapter = second.find((a) => a.absPath === adapterAbs);
    const sidecar = second.find((a) => a.absPath === sidecarPath(adapterAbs));

    expect(fs.readFileSync(adapterAbs, 'utf-8')).toBe(adapter?.expectedContent);
    expect(fs.readFileSync(sidecarPath(adapterAbs), 'utf-8')).toBe(sidecar?.expectedContent);
  });

  // Regression: the payload adapter + sidecar previously carried a hardcoded `target: 'claude'`
  // even for envelopes that never declare `claude` (e.g. a codex-only plugin), misreporting
  // `BuildResult.artifacts` for that target's build step. The adapter is shared across the whole
  // envelope, so it must be attributed deterministically to a target actually present in the
  // envelope: `claude` when declared, otherwise the first envelope target in canonical
  // (`TARGET_IDS`) order.
  it('attributes the shared payload-adapter artifacts to a target present in the envelope', () => {
    pluginDir = writePluginWithHooks(HOOKS_YAML);
    const adapterAbs = path.join(pluginDir, 'hooks', PAYLOAD_ADAPTER_FILENAME);

    const cases: { envelope: ('claude' | 'cursor' | 'gemini')[]; expectedTarget: string }[] = [
      { envelope: ['claude'], expectedTarget: 'claude' },
      { envelope: ['cursor', 'claude', 'gemini'], expectedTarget: 'claude' },
      // No `claude` in the envelope: falls back to the first envelope target in canonical
      // (TARGET_IDS) order, never the hardcoded 'claude'.
      { envelope: ['gemini'], expectedTarget: 'gemini' },
      { envelope: ['gemini', 'cursor'], expectedTarget: 'cursor' },
    ];

    for (const { envelope, expectedTarget } of cases) {
      const artifacts = computePluginHookArtifacts(pluginDir, envelope);
      const adapter = artifacts.find((a) => a.absPath === adapterAbs);
      const sidecar = artifacts.find((a) => a.absPath === sidecarPath(adapterAbs));

      expect(adapter?.target, `envelope ${envelope.join(',')}`).toBe(expectedTarget);
      expect(sidecar?.target, `envelope ${envelope.join(',')}`).toBe(expectedTarget);
    }
  });
});
