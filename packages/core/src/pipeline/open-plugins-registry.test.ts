/**
 * Tests for the Open Plugins repo-root marketplace registry (the 4th generated registry).
 *
 * Open Plugins hosts resolve a `marketplace.json` at the repo ROOT (spec §2.4 lookup position 1).
 * Unlike the vendor-dir registries (Claude/Cursor/Codex), this repo-root file is a repo-root path
 * the toolkit writes, so it is COLLISION-GUARDED via the generated-root sidecar (OP-D5/VT-4): a
 * pre-existing foreign root `marketplace.json` raises a hard `root-artifact-collision` and is never
 * overwritten or orphan-removed.
 *
 * This suite exercises `runBuild`/`runValidate` against self-contained synth repos (no template
 * checkout) to verify:
 *   - The root registry is emitted iff at least one plugin declares `open-plugins`.
 *   - Entry shape is spec §2.4 string-source `{ name, source, description?, keywords? }` — note the
 *     Open Plugins override field is `keywords`, NOT the Claude/Cursor `tags`.
 *   - Byte-stable serialization (2-space JSON + trailing newline); build→validate is clean.
 *   - The sidecar tracks `marketplace.json`; a foreign pre-existing root file collides and is
 *     preserved byte-for-byte.
 *   - Orphan removal fires when the last `open-plugins` declarer is dropped (toolkit-generated only).
 *
 * Assertions are spec-first: expected registry shapes trace to the Open Plugins marketplace spec.
 *
 * @see https://open-plugins.com/plugin-builders/marketplace.md
 * @see docs/specs/open-plugins-target.md (OP-D3, OP-D4, OP-D5, VT-4)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runBuild, serializeRootManifest } from './build.js';
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

/** Read+parse a JSON file under `repoRoot`. */
function readJson(repoRoot: string, ...rel: string[]): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, ...rel), 'utf-8')) as unknown;
}

const ROOT_MARKETPLACE = 'marketplace.json';
const SIDECAR_REL = ['.aipm', 'generated-root.json'] as const;

/**
 * An Open-Plugins-declaring plugin carrying the required `.plugin/plugin.json` manifest (name
 * matching the directory basename so name-consistency and the metadata-dir isolation check pass).
 */
function openPluginsPlugin(name: string, meta?: SynthRegistryPlugin['meta']): SynthRegistryPlugin {
  return {
    name,
    targets: ['open-plugins'],
    ...(meta !== undefined ? { meta } : {}),
    files: {
      '.plugin/plugin.json': `{\n  "schemaVersion": "0.1.0",\n  "name": "${name}",\n  "version": "0.0.1"\n}\n`,
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

describe('open-plugins registry — emission gating', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('emits a repo-root marketplace.json when at least one plugin declares open-plugins', async () => {
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    await runBuild(repo.repoRoot);
    expect(exists(repo.repoRoot, ROOT_MARKETPLACE)).toBe(true);
  });

  it('does NOT emit a repo-root marketplace.json when no plugin declares open-plugins', async () => {
    // A claude-only plugin: vendor registry is written, but no repo-root open-plugins registry.
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude'] }], WORKSPACE);
    await runBuild(repo.repoRoot);
    expect(exists(repo.repoRoot, ROOT_MARKETPLACE)).toBe(false);
    expect(exists(repo.repoRoot, '.claude-plugin', 'marketplace.json')).toBe(true);
  });
});

describe('open-plugins registry — entry shape (spec §2.4)', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('writes { name, plugins: [{ name, source }] }, source = ./plugins/<name> POSIX', async () => {
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    await runBuild(repo.repoRoot);

    const registry = readJson(repo.repoRoot, ROOT_MARKETPLACE) as Record<string, unknown>;
    // spec §2.4: top-level name required; no owner/metadata when workspace omits them.
    expect(Object.keys(registry).sort()).toStrictEqual(['name', 'plugins']);
    expect(registry['name']).toBe('m');
    expect(registry['plugins']).toStrictEqual([{ name: 'alpha', source: './plugins/alpha' }]);
  });

  it('uses the entry field `keywords` (NOT the Claude/Cursor `tags`) and includes description', async () => {
    repo = synthRegistryRepo(
      [openPluginsPlugin('alpha', { description: 'Alpha plugin', keywords: ['a', 'b'] })],
      WORKSPACE,
    );
    await runBuild(repo.repoRoot);

    const registry = readJson(repo.repoRoot, ROOT_MARKETPLACE) as {
      plugins: Record<string, unknown>[];
    };
    expect(registry.plugins).toStrictEqual([
      {
        name: 'alpha',
        source: './plugins/alpha',
        description: 'Alpha plugin',
        keywords: ['a', 'b'],
      },
    ]);
    // Guard: the Claude/Cursor `tags` field must NOT leak into the Open Plugins registry.
    expect(registry.plugins[0]).not.toHaveProperty('tags');
  });

  it('carries the workspace owner at the top level when present', async () => {
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], {
      name: 'm',
      owner: { name: 'Owner', email: 'o@example.com' },
    });
    await runBuild(repo.repoRoot);

    const registry = readJson(repo.repoRoot, ROOT_MARKETPLACE) as Record<string, unknown>;
    expect(registry['owner']).toStrictEqual({ name: 'Owner', email: 'o@example.com' });
    // metadata.pluginRoot stays at its default (".") — omitted (OP-D4).
    expect(registry).not.toHaveProperty('metadata');
  });

  it('serializes as 2-space JSON with a trailing newline', async () => {
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    await runBuild(repo.repoRoot);
    const raw = fs.readFileSync(path.join(repo.repoRoot, ROOT_MARKETPLACE), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "name"');
  });

  it('is byte-stable: a second build reproduces the identical bytes', async () => {
    repo = synthRegistryRepo(
      [openPluginsPlugin('alpha', { description: 'Alpha', keywords: ['x'] })],
      WORKSPACE,
    );
    await runBuild(repo.repoRoot);
    const first = fs.readFileSync(path.join(repo.repoRoot, ROOT_MARKETPLACE), 'utf-8');
    await runBuild(repo.repoRoot);
    const second = fs.readFileSync(path.join(repo.repoRoot, ROOT_MARKETPLACE), 'utf-8');
    expect(second).toBe(first);
  });
});

describe('open-plugins registry — freshness (workspace present)', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('a built repo validates clean with no findings', async () => {
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    await runBuild(repo.repoRoot);
    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(result.findings).toStrictEqual([]);
    expect(result.passed).toBe(true);
  });

  it('tracks marketplace.json in the generated-root sidecar', async () => {
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    await runBuild(repo.repoRoot);
    expect(readSidecarPaths(repo.repoRoot)).toContain(ROOT_MARKETPLACE);
  });

  it('a hand-edited root registry is a HARD freshness finding under ci:true', async () => {
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    await runBuild(repo.repoRoot);

    const mkt = path.join(repo.repoRoot, ROOT_MARKETPLACE);
    fs.appendFileSync(mkt, ' ');
    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.some((f) => f.message.includes(ROOT_MARKETPLACE))).toBe(true);
    expect(fresh.every((f) => f.severity === 'hard')).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('open-plugins registry — collision guard (OP-D5 / VT-4)', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('a foreign pre-existing root marketplace.json → hard root-artifact-collision, file NOT overwritten', async () => {
    const FOREIGN = '{\n  "this": "is host-owned, do not touch"\n}\n';
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    // Plant a repo-root marketplace.json the toolkit did not generate (untracked in the sidecar).
    fs.writeFileSync(path.join(repo.repoRoot, ROOT_MARKETPLACE), FOREIGN, 'utf-8');

    await runBuild(repo.repoRoot);

    // The foreign file is preserved byte-for-byte; the open-plugins registry is suppressed.
    expect(fs.readFileSync(path.join(repo.repoRoot, ROOT_MARKETPLACE), 'utf-8')).toBe(FOREIGN);

    const result = await runValidate(repo.repoRoot, { ci: true });
    const collision = ofCode(result.findings, 'root-artifact-collision');
    expect(collision.length).toBeGreaterThanOrEqual(1);
    expect(collision.every((f) => f.severity === 'hard')).toBe(true);
    expect(collision.some((f) => f.message.includes(ROOT_MARKETPLACE))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('does not touch the foreign file even across a second build', async () => {
    const FOREIGN = '{\n  "host": "owned"\n}\n';
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    fs.writeFileSync(path.join(repo.repoRoot, ROOT_MARKETPLACE), FOREIGN, 'utf-8');
    await runBuild(repo.repoRoot);
    await runBuild(repo.repoRoot);
    expect(fs.readFileSync(path.join(repo.repoRoot, ROOT_MARKETPLACE), 'utf-8')).toBe(FOREIGN);
  });

  // Regression (PR #28 review): an `aipm init`-seeded repo has a root marketplace.json on disk.
  // Without the seed being pre-tracked in the sidecar, later adopting workspace mode would raise
  // root-artifact-collision against the toolkit's OWN seed and suppress the registry. init now
  // seeds `.aipm/generated-root.json` tracking `marketplace.json`, so adoption regenerates cleanly.
  it('an init-seeded root marketplace.json (pre-tracked in the sidecar) is adopted, not a collision', async () => {
    const SEED = '{\n  "name": "seeded",\n  "plugins": []\n}\n';
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    // Simulate the `aipm init` seed state: root registry on disk + sidecar tracking it.
    fs.writeFileSync(path.join(repo.repoRoot, ROOT_MARKETPLACE), SEED, 'utf-8');
    fs.mkdirSync(path.join(repo.repoRoot, '.aipm'), { recursive: true });
    fs.writeFileSync(
      path.join(repo.repoRoot, ...SIDECAR_REL),
      serializeRootManifest([ROOT_MARKETPLACE]),
      'utf-8',
    );

    await runBuild(repo.repoRoot);

    // The seed was regenerated (adopted), not preserved as foreign, and nothing collided.
    const registry = readJson(repo.repoRoot, ROOT_MARKETPLACE) as { plugins: { name: string }[] };
    expect(registry.plugins.map((p) => p.name)).toStrictEqual(['alpha']);
    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(result.findings, 'root-artifact-collision')).toStrictEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('open-plugins registry — orphan removal', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('dropping the last open-plugins declarer removes the toolkit-generated root registry on rebuild', async () => {
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    await runBuild(repo.repoRoot);
    expect(exists(repo.repoRoot, ROOT_MARKETPLACE)).toBe(true);
    expect(readSidecarPaths(repo.repoRoot)).toContain(ROOT_MARKETPLACE);

    // Drop the only open-plugins declarer and rebuild.
    fs.rmSync(path.join(repo.repoRoot, 'plugins', 'alpha'), { recursive: true });
    await runBuild(repo.repoRoot);

    // The toolkit-generated root registry is orphan-removed; the sidecar no longer tracks it.
    expect(exists(repo.repoRoot, ROOT_MARKETPLACE)).toBe(false);
    expect(readSidecarPaths(repo.repoRoot)).not.toContain(ROOT_MARKETPLACE);
  });

  it('validate flags a stale orphaned root registry when not rebuilt', async () => {
    repo = synthRegistryRepo([openPluginsPlugin('alpha')], WORKSPACE);
    await runBuild(repo.repoRoot);
    // Drop the declarer but DO NOT rebuild — the generated root registry + sidecar still sit on disk.
    fs.rmSync(path.join(repo.repoRoot, 'plugins', 'alpha'), { recursive: true });

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.some((f) => f.message.includes(ROOT_MARKETPLACE))).toBe(true);
    expect(result.passed).toBe(false);
  });
});
