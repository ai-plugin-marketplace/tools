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
import { GeneratorDowngradeError, getGeneratorVersion } from './generator-version.js';
import {
  hasSentinel,
  readSentinelSource,
  readSentinelVersion,
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

/**
 * Explicit generator-version stamp (§4.3.1) used where a test computes an artifact AND its expected
 * sentinel bytes: passing the same version to `computePluginHookArtifacts` and `sidecarContent`
 * keeps the assertion independent of the installed core version.
 */
const STAMP = '9.9.9';

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

    // Select by absPath: `target === 'cursor'` is NOT unique — when a gating-event hook is
    // present, the fail-closed shim runner `hooks/cursor-shim.mjs` (+ sidecar) is also attributed
    // to `'cursor'`. Only `hooks/cursor.json`'s absPath uniquely identifies this artifact.
    const cursorJsonAbsPath = path.join(pluginDir, 'hooks', 'cursor.json');
    const cursor = artifacts.find((a) => a.absPath === cursorJsonAbsPath);
    expect(cursor).toBeDefined();
    expect(cursor?.absPath).toBe(cursorJsonAbsPath);
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

    // Select by absPath: `target === 'cursor'` is NOT unique — the fail-closed shim runner
    // (`hooks/cursor-shim.mjs` + sidecar) is also attributed to `'cursor'` when a gating-event
    // hook is present. Only the absPath uniquely identifies `hooks/cursor.json`.
    const cursorJsonAbsPath = path.join(pluginDir, 'hooks', 'cursor.json');

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
    const artifacts = computePluginHookArtifacts(pluginDir, ['cursor'], STAMP);
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
    expect(sidecar?.expectedContent).toBe(sidecarContent('hooks/claude.yaml', STAMP));
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
        STAMP,
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
      expect(sidecar?.expectedContent).toBe(sidecarContent('hooks/claude.yaml', STAMP));
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

  // Issue #58, nit 1: a hooks YAML that exists but declares zero hook events (`hooks: {}`) — a
  // plugin that authors the file but wires no handler — must not receive the adapter or its
  // sentinel; nothing could ever invoke it.
  const HOOKLESS_HOOKS_YAML = 'hooks: {}\n';

  it('emits neither hooks/payload-adapter nor its sidecar for a hookless plugin (`hooks: {}`) — issue #58 nit 1', () => {
    pluginDir = writePluginWithHooks(HOOKLESS_HOOKS_YAML);
    const adapterAbs = path.join(pluginDir, 'hooks', PAYLOAD_ADAPTER_FILENAME);

    for (const envelope of [['claude'], ['cursor'], ['gemini'], ['claude', 'cursor', 'gemini']]) {
      const artifacts = computePluginHookArtifacts(
        pluginDir,
        envelope as ('claude' | 'cursor' | 'gemini')[],
      );
      expect(
        artifacts.find((a) => a.absPath === adapterAbs),
        `envelope ${envelope.join(',')}`,
      ).toBeUndefined();
      expect(
        artifacts.find((a) => a.absPath === sidecarPath(adapterAbs)),
        `envelope ${envelope.join(',')}`,
      ).toBeUndefined();
    }
  });

  it('still emits hooks/claude.json for a hookless plugin when `claude` is declared — only the adapter is skipped', () => {
    const dir = writePluginWithHooks(HOOKLESS_HOOKS_YAML);
    pluginDir = dir;
    const artifacts = computePluginHookArtifacts(dir, ['claude']);
    const claudeJson = artifacts.find((a) => a.absPath === path.join(dir, 'hooks', 'claude.json'));
    expect(claudeJson).toBeDefined();
    expect(
      JSON.parse(stripSentinel(claudeJson?.expectedContent ?? '', 'json-field')) as unknown,
    ).toStrictEqual({ hooks: {} });
  });

  it('still emits hooks/payload-adapter + its sidecar when the plugin declares ≥1 hook — issue #58 nit 1 positive case', () => {
    pluginDir = writePluginWithHooks(HOOKS_YAML);
    const adapterAbs = path.join(pluginDir, 'hooks', PAYLOAD_ADAPTER_FILENAME);
    const artifacts = computePluginHookArtifacts(pluginDir, ['claude']);
    expect(artifacts.find((a) => a.absPath === adapterAbs)).toBeDefined();
    expect(artifacts.find((a) => a.absPath === sidecarPath(adapterAbs))).toBeDefined();
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

  // Regression: the payload adapter + sidecar previously attributed themselves to a single,
  // deterministically-chosen envelope target (`claude` when declared, else the first envelope
  // target in canonical order) — an arbitrary owner that misrepresented `BuildResult.artifacts`
  // for that target's build step, since no single target's build step actually produces this
  // file. They must report `target: 'shared'` regardless of which targets the envelope declares,
  // never a real `TargetId`.
  it("attributes the shared payload-adapter artifacts to `'shared'`, regardless of envelope", () => {
    pluginDir = writePluginWithHooks(HOOKS_YAML);
    const adapterAbs = path.join(pluginDir, 'hooks', PAYLOAD_ADAPTER_FILENAME);

    const envelopes: ('claude' | 'cursor' | 'gemini')[][] = [
      ['claude'],
      ['cursor', 'claude', 'gemini'],
      ['gemini'],
      ['gemini', 'cursor'],
    ];

    for (const envelope of envelopes) {
      const artifacts = computePluginHookArtifacts(pluginDir, envelope);
      const adapter = artifacts.find((a) => a.absPath === adapterAbs);
      const sidecar = artifacts.find((a) => a.absPath === sidecarPath(adapterAbs));

      expect(adapter?.target, `envelope ${envelope.join(',')}`).toBe('shared');
      expect(sidecar?.target, `envelope ${envelope.join(',')}`).toBe('shared');
    }
  });
});

// ---------------------------------------------------------------------------
// runBuild — payload adapter executable bit (template-independent;
// docs/specs/payload-adapter.md §1/§11)
//
// Regression: `computePluginHookArtifacts` writes go through `writeFileEnsuringDir`, which is a
// plain `fs.writeFileSync` at mode 0644 for every hook artifact — but §1/§11 document invoking
// `hooks/payload-adapter` DIRECTLY (`payload=$(".../hooks/payload-adapter")`), which fails EACCES
// without the executable bit. Exercises the real `runBuild` write path (not the pure
// `computePluginHookArtifacts` compute step) so the on-disk mode is actually observed.
// ---------------------------------------------------------------------------

describe('runBuild — payload adapter executable bit (§1/§11 regression)', () => {
  let repoRoot: string | undefined;

  afterEach(() => {
    if (repoRoot && fs.existsSync(repoRoot)) fs.rmSync(repoRoot, { recursive: true });
  });

  it('emits hooks/payload-adapter with the executable bit set, but not its .generated sidecar', async () => {
    // POSIX permission bits are not meaningful on Windows; skip there.
    if (process.platform === 'win32') return;

    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-payload-adapter-exec-'));
    const pluginDir = path.join(repoRoot, 'plugins', 'exec-bit-plugin');
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'aipm.config.ts'),
      "import { defineConfig } from '@ai-plugin-marketplace/core';\n\nexport default defineConfig({\n  version: '0.1.0',\n  targets: ['cursor'],\n});\n",
      'utf-8',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'claude.yaml'),
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { type: command, command: ./guard.sh }\n',
      'utf-8',
    );

    await runBuild(pluginDir);

    const adapterAbs = path.join(pluginDir, 'hooks', PAYLOAD_ADAPTER_FILENAME);
    const sidecarAbs = sidecarPath(adapterAbs);
    expect(fs.existsSync(adapterAbs)).toBe(true);
    expect(fs.existsSync(sidecarAbs)).toBe(true);

    expect((fs.statSync(adapterAbs).mode & 0o111) !== 0).toBe(true);
    // The .generated sidecar is never invoked directly — it must NOT carry the executable bit.
    expect((fs.statSync(sidecarAbs).mode & 0o111) !== 0).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runBuild — generator-version downgrade guard (template-independent; §4.3.1)
//
// Regression for issue #76: a stale installed toolkit that is OLDER than the version stamped into
// a committed artifact must REFUSE to build (rather than silently revert the artifact to its older
// output). Exercises the real `runBuild` path end-to-end: build once to stamp, tamper the stamp to
// a future version to simulate "committed by a newer toolkit", then rebuild and assert it refuses
// AND leaves the artifact untouched.
// ---------------------------------------------------------------------------

describe('runBuild — generator-version downgrade guard (§4.3.1)', () => {
  let repoRoot: string | undefined;

  afterEach(() => {
    if (repoRoot && fs.existsSync(repoRoot)) fs.rmSync(repoRoot, { recursive: true });
  });

  /** Scaffold a minimal single-plugin repo declaring `cursor` with a gating hooks source. */
  function writeMinimalPlugin(): string {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-downgrade-'));
    const pluginDir = path.join(repoRoot, 'plugins', 'guard-plugin');
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'aipm.config.ts'),
      "import { defineConfig } from '@ai-plugin-marketplace/core';\n\nexport default defineConfig({\n  version: '0.1.0',\n  targets: ['cursor'],\n});\n",
      'utf-8',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'claude.yaml'),
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { type: command, command: ./guard.sh }\n',
      'utf-8',
    );
    return pluginDir;
  }

  /** Rewrite the `_generated.version` stamp of a json-field artifact to `version`. */
  function restampJsonArtifact(absPath: string, version: string): void {
    const obj = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as {
      _generated: Record<string, unknown>;
    };
    obj._generated['version'] = version;
    fs.writeFileSync(absPath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  }

  it('fresh generation stamps the installed generator version (criterion 2)', async () => {
    const pluginDir = writeMinimalPlugin();
    await runBuild(pluginDir);
    const cursorJson = fs.readFileSync(path.join(pluginDir, 'hooks', 'cursor.json'), 'utf-8');
    expect(readSentinelVersion(cursorJson, 'json-field')).toBe(getGeneratorVersion());
  });

  it('a same-version rebuild proceeds and restamps, no error (criterion 3/4)', async () => {
    const pluginDir = writeMinimalPlugin();
    await runBuild(pluginDir);
    // Second build sees an artifact stamped by the SAME (installed) version → allowed.
    await expect(runBuild(pluginDir)).resolves.toBeDefined();
    const cursorJson = fs.readFileSync(path.join(pluginDir, 'hooks', 'cursor.json'), 'utf-8');
    expect(readSentinelVersion(cursorJson, 'json-field')).toBe(getGeneratorVersion());
  });

  it('REFUSES (throws, names both versions) and does NOT rewrite when the installed toolkit is older (criterion 1/5)', async () => {
    const pluginDir = writeMinimalPlugin();
    await runBuild(pluginDir);

    // Simulate a stale install: the committed artifact was produced by a FUTURE generator, newer
    // than the one now running.
    const cursorJsonPath = path.join(pluginDir, 'hooks', 'cursor.json');
    const futureVersion = '99.0.0';
    restampJsonArtifact(cursorJsonPath, futureVersion);
    const tamperedBytes = fs.readFileSync(cursorJsonPath, 'utf-8');

    // The build must refuse.
    const installed = getGeneratorVersion();
    let thrown: unknown;
    try {
      await runBuild(pluginDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GeneratorDowngradeError);
    const err = thrown as GeneratorDowngradeError;
    // Message names BOTH versions.
    expect(err.message).toContain(`@ai-plugin-marketplace/core@${installed}`);
    expect(err.message).toContain(`@ai-plugin-marketplace/core@${futureVersion}`);

    // And it did NOT overwrite the artifact (the whole build aborted before any write).
    expect(fs.readFileSync(cursorJsonPath, 'utf-8')).toBe(tamperedBytes);
  });

  it('proceeds under forceDowngrade and restamps with the installed (older) version', async () => {
    const pluginDir = writeMinimalPlugin();
    await runBuild(pluginDir);
    restampJsonArtifact(path.join(pluginDir, 'hooks', 'cursor.json'), '99.0.0');

    await expect(runBuild(pluginDir, { forceDowngrade: true })).resolves.toBeDefined();
    const cursorJson = fs.readFileSync(path.join(pluginDir, 'hooks', 'cursor.json'), 'utf-8');
    // Restamped down to the installed version (the guard was overridden).
    expect(readSentinelVersion(cursorJson, 'json-field')).toBe(getGeneratorVersion());
  });
});

// ---------------------------------------------------------------------------
// runBuild — plugin-shaped repo-root subdirectory missing aipm.config.ts (#91, template-independent)
//
// Regression for issue #91: `mv p/aipm.config.ts aside` on a plugin-shaped directory used to
// silently drop it from discovery, so `aipm build` reported "Built 0 plugin(s)" with exit 0. It
// must now surface a clear, non-zero-exit diagnostic instead.
// ---------------------------------------------------------------------------

describe('runBuild — plugin-shaped repo-root subdirectory missing aipm.config.ts (#91)', () => {
  let repoRoot: string | undefined;

  afterEach(() => {
    if (repoRoot && fs.existsSync(repoRoot)) fs.rmSync(repoRoot, { recursive: true });
  });

  it('throws a clear diagnostic instead of silently building 0 plugins (repro: manifest present, config removed)', async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-build-no-config-'));
    const pluginDir = path.join(repoRoot, 'plugins', 'p');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'p', version: '0.1.0' }),
      'utf-8',
    );
    // No aipm.config.ts — repro: `mv p/aipm.config.ts aside`.

    await expect(runBuild(repoRoot)).rejects.toThrow(/aipm\.config\.ts/);
  });

  it('throws for a config-less directory identified only by a skill (no target manifest)', async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-build-no-config-skill-'));
    const pluginDir = path.join(repoRoot, 'plugins', 'p');
    fs.mkdirSync(path.join(pluginDir, 'skills', 'my-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: demo\n---\n\n# Body\n',
      'utf-8',
    );

    await expect(runBuild(repoRoot)).rejects.toThrow(/aipm\.config\.ts/);
  });
});
