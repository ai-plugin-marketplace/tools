/**
 * Tests for single-artifact-host repo-root native emission (Phase 1) — Gemini / Kiro.
 *
 * Gemini CLI and Kiro have NO multi-plugin marketplace concept: each installs ONE extension/power
 * per repo, read from the repo ROOT (`gemini extensions install <git>` reads root
 * `gemini-extension.json`; Kiro "Add from GitHub" reads root `POWER.md`). This suite exercises
 * `runBuild`/`runValidate` against a self-contained synth repo (no template checkout) to verify:
 *
 *   - WITH `aipm.workspace.ts` + exactly one declarer per host: the host's bundle is emitted at the
 *     repo ROOT (the same files `bundleGeminiPlugin`/`bundleKiroPlugin` produce) and a sidecar
 *     manifest (`.aipm/generated-root.json`) lists them; validate is clean.
 *   - N=1 gate: two plugins declaring the SAME host → a hard `single-artifact-host` finding and NO
 *     root artifact for that host. The two hosts are independent (one gemini + one kiro is allowed).
 *   - Collision guard: a pre-existing non-generated root file → a hard `root-artifact-collision`
 *     finding and the original file is NOT overwritten.
 *   - Freshness: a hand-edited generated root artifact is a `freshness` finding; rebuild clears it.
 *   - Orphan: dropping a declarer removes the previously-generated root paths; validate flags stale
 *     orphans when not rebuilt.
 *   - Safety: unrelated root files (README.md, package.json, src/) survive a build untouched.
 *   - Backward compat: no `aipm.workspace.ts` → none of this triggers.
 *
 * Assertions are spec-first: expected root file sets trace to the bundlers' documented output
 * (gemini/bundle.ts, kiro/bundle.ts), not to captured program output.
 *
 * @see packages/core/src/targets/gemini/bundle.ts (bundleGeminiPlugin — root file set)
 * @see packages/core/src/targets/kiro/bundle.ts (bundleKiroPlugin — root file set)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runBuild } from './build.js';
import { runValidate } from './validate.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryPlugin, SynthRegistryRepo } from '../test-support/synth-plugin.js';
import type { Finding, FindingCode } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Findings of a given code. */
function ofCode(findings: Finding[], code: FindingCode): Finding[] {
  return findings.filter((f) => f.code === code);
}

/** True iff `repoRoot/<rel...>` exists. */
function exists(repoRoot: string, ...rel: string[]): boolean {
  return fs.existsSync(path.join(repoRoot, ...rel));
}

const SIDECAR_REL = ['.aipm', 'generated-root.json'] as const;

/** A minimal Gemini-declaring plugin carrying the canonical root host source files. */
function geminiPlugin(name: string): SynthRegistryPlugin {
  return {
    name,
    targets: ['gemini'],
    files: {
      // bundleGeminiPlugin copies these flat files + commands/*.toml verbatim to the root.
      'gemini-extension.json': `{\n  "name": "${name}",\n  "version": "0.0.1"\n}\n`,
      'GEMINI.md': `# ${name}\n`,
      'commands/hello.toml': 'description = "hi"\n',
    },
  };
}

/** A minimal Kiro-declaring plugin carrying the canonical root host source files. */
function kiroPlugin(name: string): SynthRegistryPlugin {
  return {
    name,
    targets: ['kiro'],
    files: {
      // bundleKiroPlugin copies POWER.md + mcp.json verbatim to the root. The Kiro per-target
      // schema requires name/description/version in the POWER.md frontmatter (kiro/schemas.ts).
      'POWER.md': `---\nname: ${name}\ndescription: ${name} power\nversion: 0.0.1\n---\n# ${name}\n`,
      'mcp.json': '{\n  "mcpServers": {}\n}\n',
    },
  };
}

/**
 * A single plugin declaring BOTH single-artifact hosts and carrying a skill shared by the gemini
 * and kiro bundles — the dogfood shape. The shared `skills/<name>/SKILL.md` is emitted to the root
 * once but is collected once per host by the freshness oracle; this is the regression case for the
 * sidecar dedupe in `serializeRootManifest`.
 */
function comboPlugin(name: string): SynthRegistryPlugin {
  return {
    name,
    targets: ['gemini', 'kiro'],
    files: {
      'gemini-extension.json': `{\n  "name": "${name}",\n  "version": "0.0.1"\n}\n`,
      'GEMINI.md': `# ${name}\n`,
      'POWER.md': `---\nname: ${name}\ndescription: ${name} power\nversion: 0.0.1\n---\n# ${name}\n`,
      'mcp.json': '{\n  "mcpServers": {}\n}\n',
      'skills/skill-x/SKILL.md': `---\nname: skill-x\ndescription: a shared skill\n---\n# skill-x\n`,
    },
  };
}

/** Parse the sidecar manifest's tracked `paths`. */
function readSidecarPaths(repoRoot: string): string[] {
  const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, ...SIDECAR_REL), 'utf-8')) as {
    version: number;
    paths: string[];
  };
  return raw.paths;
}

const WORKSPACE = { name: 'm' } as const;

// ---------------------------------------------------------------------------

describe('single-artifact-host — root emission (workspace present, N=1)', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('emits a single gemini extension and a single kiro power at the repo root from distinct plugins', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem'), kiroPlugin('kir')], WORKSPACE);
    await runBuild(repo.repoRoot);

    // gemini/bundle.ts: gemini-extension.json, GEMINI.md, commands/*.toml at the root.
    expect(exists(repo.repoRoot, 'gemini-extension.json')).toBe(true);
    expect(exists(repo.repoRoot, 'GEMINI.md')).toBe(true);
    expect(exists(repo.repoRoot, 'commands', 'hello.toml')).toBe(true);
    // kiro/bundle.ts: POWER.md, mcp.json at the root. Distinct files from gemini's.
    expect(exists(repo.repoRoot, 'POWER.md')).toBe(true);
    expect(exists(repo.repoRoot, 'mcp.json')).toBe(true);

    // Content traces to the owning plugin's source (verbatim copy).
    const ext = JSON.parse(
      fs.readFileSync(path.join(repo.repoRoot, 'gemini-extension.json'), 'utf-8'),
    ) as { name: string };
    expect(ext.name).toBe('gem');

    // Sidecar lists exactly the generated root paths (POSIX, sorted), and NOT itself.
    const tracked = readSidecarPaths(repo.repoRoot);
    expect(tracked).toStrictEqual(
      ['GEMINI.md', 'POWER.md', 'commands/hello.toml', 'gemini-extension.json', 'mcp.json'].sort(),
    );
    expect(tracked).not.toContain('.aipm/generated-root.json');
  });

  it('validates clean after a build (no findings of any root-related code)', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem'), kiroPlugin('kir')], WORKSPACE);
    await runBuild(repo.repoRoot);
    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(result.findings, 'single-artifact-host')).toStrictEqual([]);
    expect(ofCode(result.findings, 'root-artifact-collision')).toStrictEqual([]);
    expect(ofCode(result.findings, 'freshness')).toStrictEqual([]);
    expect(result.passed).toBe(true);
  });

  it('emits the sidecar manifest as 2-space JSON with a trailing newline and version 1', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem')], WORKSPACE);
    await runBuild(repo.repoRoot);
    const raw = fs.readFileSync(path.join(repo.repoRoot, ...SIDECAR_REL), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "version"'); // 2-space indentation
    const parsed = JSON.parse(raw) as { version: number };
    expect(parsed.version).toBe(1);
  });

  // Regression: the sidecar manifest spans every emitted single-artifact-host/registry owner
  // (gemini AND kiro here), so `GeneratedFile.target` previously had to attribute it to one of
  // them (a deterministically-chosen, arbitrary owner). It must report `target: 'shared'` instead
  // of picking one of the actual owners.
  it("records the sidecar manifest artifact with target `'shared'` when multiple hosts emit", async () => {
    repo = synthRegistryRepo([geminiPlugin('gem'), kiroPlugin('kir')], WORKSPACE);
    const results = await runBuild(repo.repoRoot);

    const manifestAbs = path.join(repo.repoRoot, ...SIDECAR_REL);
    const sidecarArtifacts = results.flatMap((r) =>
      r.artifacts.filter((a) => a.path === manifestAbs),
    );
    expect(sidecarArtifacts.length).toBeGreaterThan(0);
    for (const artifact of sidecarArtifacts) {
      expect(artifact.target).toBe('shared');
    }
  });
});

describe('single-artifact-host — N=1 gate (two plugins, same host)', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('two gemini declarers → hard single-artifact-host finding and NO root gemini-extension.json', async () => {
    repo = synthRegistryRepo([geminiPlugin('alpha'), geminiPlugin('beta')], WORKSPACE);
    await runBuild(repo.repoRoot);

    // Gate suppresses emission entirely.
    expect(exists(repo.repoRoot, 'gemini-extension.json')).toBe(false);
    expect(exists(repo.repoRoot, 'GEMINI.md')).toBe(false);

    const result = await runValidate(repo.repoRoot, { ci: true });
    const gate = ofCode(result.findings, 'single-artifact-host');
    expect(gate).toHaveLength(1);
    expect(gate[0]?.severity).toBe('hard');
    expect(gate[0]?.message).toContain('gemini');
    // Names both declarers so the author knows which to deduplicate.
    expect(gate[0]?.message).toContain('alpha');
    expect(gate[0]?.message).toContain('beta');
    expect(result.passed).toBe(false);
  });

  it('one gemini + one kiro (distinct hosts) → both emitted, no gate finding', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem'), kiroPlugin('kir')], WORKSPACE);
    await runBuild(repo.repoRoot);

    expect(exists(repo.repoRoot, 'gemini-extension.json')).toBe(true);
    expect(exists(repo.repoRoot, 'POWER.md')).toBe(true);

    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(result.findings, 'single-artifact-host')).toStrictEqual([]);
  });

  it('build with failFast throws on an ambiguous host (gate surfaces in post-build validate)', async () => {
    repo = synthRegistryRepo([geminiPlugin('alpha'), geminiPlugin('beta')], WORKSPACE);
    await expect(runBuild(repo.repoRoot, { failFast: true })).rejects.toThrow(
      /single-artifact-host/,
    );
  });
});

describe('single-artifact-host — collision guard', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('a pre-existing non-generated root GEMINI.md → hard root-artifact-collision, original NOT overwritten', async () => {
    const ORIGINAL = '# HOST-OWNED, do not touch\n';
    repo = synthRegistryRepo([geminiPlugin('gem')], WORKSPACE);
    // Plant a host-owned root file the toolkit does not track as generated.
    fs.writeFileSync(path.join(repo.repoRoot, 'GEMINI.md'), ORIGINAL, 'utf-8');

    await runBuild(repo.repoRoot);

    // The collider is preserved byte-for-byte; the whole gemini host is suppressed.
    expect(fs.readFileSync(path.join(repo.repoRoot, 'GEMINI.md'), 'utf-8')).toBe(ORIGINAL);
    expect(exists(repo.repoRoot, 'gemini-extension.json')).toBe(false);

    const result = await runValidate(repo.repoRoot, { ci: true });
    const collision = ofCode(result.findings, 'root-artifact-collision');
    expect(collision.length).toBeGreaterThanOrEqual(1);
    expect(collision.every((f) => f.severity === 'hard')).toBe(true);
    expect(collision.some((f) => f.message.includes('GEMINI.md'))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('a pre-existing root commands/ dir collides and suppresses the gemini host', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem')], WORKSPACE);
    // Plant a host-owned commands/hello.toml at the root — the bundle would write the same path.
    const planted = path.join(repo.repoRoot, 'commands', 'hello.toml');
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, 'description = "HOST OWNED"\n', 'utf-8');

    await runBuild(repo.repoRoot);

    expect(fs.readFileSync(planted, 'utf-8')).toBe('description = "HOST OWNED"\n');
    expect(exists(repo.repoRoot, 'gemini-extension.json')).toBe(false);

    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(result.findings, 'root-artifact-collision').length).toBeGreaterThanOrEqual(1);
  });
});

describe('single-artifact-host — freshness', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('one plugin declaring both gemini AND kiro builds, then re-validates clean (sidecar dedupe)', async () => {
    // Regression: a skill shared by both bundles lands in the sidecar once (build dedupes via a
    // Set), but the freshness oracle collects it once per emitting host. Before the dedupe in
    // serializeRootManifest, the sidecar read as perpetually stale right after a build.
    repo = synthRegistryRepo([comboPlugin('combo')], WORKSPACE);
    await runBuild(repo.repoRoot);

    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(result.findings.filter((f) => f.code === 'freshness')).toStrictEqual([]);
    expect(result.passed).toBe(true);
    // The shared skill is tracked exactly once.
    expect(readSidecarPaths(repo.repoRoot).filter((p) => p.endsWith('skill-x/SKILL.md'))).toEqual([
      'skills/skill-x/SKILL.md',
    ]);
  });

  it('a hand-edited generated root artifact is a HARD freshness finding under ci:true', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem')], WORKSPACE);
    await runBuild(repo.repoRoot);

    // Hand-edit the generated root artifact — regeneration will diverge.
    fs.appendFileSync(path.join(repo.repoRoot, 'GEMINI.md'), 'tampered\n');

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh.every((f) => f.severity === 'hard')).toBe(true);
    expect(fresh.some((f) => f.message.includes('GEMINI.md'))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('rebuilding clears the freshness finding', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem')], WORKSPACE);
    await runBuild(repo.repoRoot);
    fs.appendFileSync(path.join(repo.repoRoot, 'GEMINI.md'), ' ');
    const dirty = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(dirty.findings, 'freshness').length).toBeGreaterThanOrEqual(1);

    await runBuild(repo.repoRoot); // regenerate (overwrites our own tracked file)
    const clean = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(clean.findings, 'freshness')).toStrictEqual([]);
  });

  it('a missing generated root artifact is a freshness finding', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem')], WORKSPACE);
    await runBuild(repo.repoRoot);
    fs.rmSync(path.join(repo.repoRoot, 'gemini-extension.json'));

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.some((f) => f.message.includes('missing'))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('a hand-edited sidecar manifest is a freshness finding', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem')], WORKSPACE);
    await runBuild(repo.repoRoot);
    fs.appendFileSync(path.join(repo.repoRoot, ...SIDECAR_REL), ' ');

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.some((f) => f.message.includes('generated-root.json'))).toBe(true);
  });
});

describe('single-artifact-host — orphan removal', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('dropping the gemini plugin removes the previously-generated root paths on rebuild', async () => {
    // First build with a gemini declarer → root artifacts + sidecar written.
    repo = synthRegistryRepo([geminiPlugin('gem')], WORKSPACE);
    await runBuild(repo.repoRoot);
    expect(exists(repo.repoRoot, 'gemini-extension.json')).toBe(true);
    const before = readSidecarPaths(repo.repoRoot);
    expect(before.length).toBeGreaterThan(0);

    // Drop the only gemini declarer (remove the plugin dir) and rebuild.
    fs.rmSync(path.join(repo.repoRoot, 'plugins', 'gem'), { recursive: true });
    await runBuild(repo.repoRoot);

    // Orphan removal deletes the previously-tracked root paths; sidecar is now empty.
    expect(exists(repo.repoRoot, 'gemini-extension.json')).toBe(false);
    expect(exists(repo.repoRoot, 'GEMINI.md')).toBe(false);
    expect(exists(repo.repoRoot, 'commands', 'hello.toml')).toBe(false);
    expect(readSidecarPaths(repo.repoRoot)).toStrictEqual([]);
  });

  it('adding a second gemini plugin disables emission via the N=1 gate and orphans the prior root output', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem')], WORKSPACE);
    await runBuild(repo.repoRoot);
    expect(exists(repo.repoRoot, 'gemini-extension.json')).toBe(true);

    // Add a SECOND gemini declarer → N>1 gate suppresses emission; the prior root output is orphaned.
    const second = path.join(repo.repoRoot, 'plugins', 'beta');
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(
      path.join(second, 'aipm.config.ts'),
      `import { defineConfig } from '@ai-plugin-marketplace/core';\nexport default defineConfig({ version: '0.1.0', targets: ['gemini'] });\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(second, 'gemini-extension.json'),
      `{\n  "name": "beta",\n  "version": "0.0.1"\n}\n`,
      'utf-8',
    );

    await runBuild(repo.repoRoot);

    // Gate suppressed emission AND orphan removal cleaned up the prior gem output.
    expect(exists(repo.repoRoot, 'gemini-extension.json')).toBe(false);
    expect(readSidecarPaths(repo.repoRoot)).toStrictEqual([]);
  });

  it('validate flags a stale orphaned root artifact when not rebuilt', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem')], WORKSPACE);
    await runBuild(repo.repoRoot);

    // Drop the declarer but DO NOT rebuild — the generated root files + sidecar still sit on disk.
    fs.rmSync(path.join(repo.repoRoot, 'plugins', 'gem'), { recursive: true });

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    // The previously-tracked, now-unexpected files are flagged as stale orphans.
    expect(fresh.some((f) => f.message.includes('gemini-extension.json'))).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('single-artifact-host — no-clobber safety', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('leaves unrelated root files (README.md, package.json, src/) untouched after a build', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem'), kiroPlugin('kir')], WORKSPACE);

    // Plant unrelated repo-root content the toolkit must never touch.
    const readme = '# My Repo\n';
    const pkg = '{\n  "name": "my-repo"\n}\n';
    const srcFile = 'export const x = 1;\n';
    fs.writeFileSync(path.join(repo.repoRoot, 'README.md'), readme, 'utf-8');
    fs.writeFileSync(path.join(repo.repoRoot, 'package.json'), pkg, 'utf-8');
    fs.mkdirSync(path.join(repo.repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.repoRoot, 'src', 'index.ts'), srcFile, 'utf-8');

    await runBuild(repo.repoRoot);

    // Unrelated files are byte-for-byte intact.
    expect(fs.readFileSync(path.join(repo.repoRoot, 'README.md'), 'utf-8')).toBe(readme);
    expect(fs.readFileSync(path.join(repo.repoRoot, 'package.json'), 'utf-8')).toBe(pkg);
    expect(fs.readFileSync(path.join(repo.repoRoot, 'src', 'index.ts'), 'utf-8')).toBe(srcFile);
    expect(fs.existsSync(path.join(repo.repoRoot, 'src'))).toBe(true);
  });
});

describe('single-artifact-host — backward compat (workspace absent)', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('emits NO root artifacts and NO sidecar when no aipm.workspace.ts is present', async () => {
    repo = synthRegistryRepo([geminiPlugin('gem'), kiroPlugin('kir')]); // no workspace
    await runBuild(repo.repoRoot);

    expect(exists(repo.repoRoot, 'gemini-extension.json')).toBe(false);
    expect(exists(repo.repoRoot, 'POWER.md')).toBe(false);
    expect(exists(repo.repoRoot, ...SIDECAR_REL)).toBe(false);
  });

  it('emits no single-artifact-host finding even when two plugins declare the same host (no workspace)', async () => {
    repo = synthRegistryRepo([geminiPlugin('alpha'), geminiPlugin('beta')]); // no workspace
    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(result.findings, 'single-artifact-host')).toStrictEqual([]);
    expect(ofCode(result.findings, 'root-artifact-collision')).toStrictEqual([]);
  });
});
