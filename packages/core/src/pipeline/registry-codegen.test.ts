/**
 * Tests for marketplace-registry generation (Phase A) — design spec
 * `docs/specs/manifest-and-registry-codegen.md` §"Marketplace registries".
 *
 * These exercise `runBuild` against a self-contained synth repo (no template checkout needed) to
 * verify the opt-in generation model:
 *   - WITH `aipm.workspace.ts`: the three registries are GENERATED from workspace metadata +
 *     discovered plugins, with exact entry shapes (Claude/Cursor string source + description/tags;
 *     Codex object source + policy + category + interface.displayName). Only registry-backed
 *     targets present in some plugin's envelope get a file.
 *   - Freshness: a hand-edited generated registry is a `freshness` finding; regenerating clears it;
 *     `marketplace-registration` does NOT also fire (subsumed, locked decision 2).
 *   - WITHOUT `aipm.workspace.ts`: nothing is generated; the existing hand-authored-registry path
 *     (`marketplace-registration`) still runs (backward compat).
 *
 * Assertions are spec-first: each expected value traces to the design spec's entry shapes, not to
 * captured program output.
 *
 * @see docs/specs/manifest-and-registry-codegen.md §"Marketplace registries"
 * @see https://developers.openai.com/codex/plugins/build
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runBuild } from './build.js';
import { runValidate } from './validate.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryRepo } from '../test-support/synth-plugin.js';
import type { Finding, FindingCode } from './types.js';

/** Read+parse a JSON file under `repoRoot`. */
function readJson(repoRoot: string, ...rel: string[]): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, ...rel), 'utf-8')) as unknown;
}

/** Findings of a given code. */
function ofCode(findings: Finding[], code: FindingCode): Finding[] {
  return findings.filter((f) => f.code === code);
}

const CLAUDE_REL = ['.claude-plugin', 'marketplace.json'] as const;
const CURSOR_REL = ['.cursor-plugin', 'marketplace.json'] as const;
const CODEX_REL = ['.agents', 'plugins', 'marketplace.json'] as const;

// ---------------------------------------------------------------------------

describe('registry generation — entry shapes (workspace present)', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('writes Claude/Cursor string-source registries with name/source/description/tags', async () => {
    repo = synthRegistryRepo(
      [
        {
          name: 'alpha',
          targets: ['claude', 'cursor'],
          meta: { description: 'Alpha plugin', keywords: ['a', 'b'] },
        },
        { name: 'beta', targets: ['claude'] }, // no description/keywords
      ],
      { name: 'my-market', owner: { name: 'Owner' }, description: 'Universal marketplace' },
    );

    await runBuild(repo.repoRoot);

    // spec §"Marketplace registries": Claude/Cursor top-level
    // { name, owner?, metadata?: { description? }, plugins: [...] }.
    const claude = readJson(repo.repoRoot, ...CLAUDE_REL) as Record<string, unknown>;
    expect(claude['name']).toBe('my-market');
    expect(claude['owner']).toStrictEqual({ name: 'Owner' });
    expect(claude['metadata']).toStrictEqual({ description: 'Universal marketplace' });

    const claudePlugins = claude['plugins'] as Record<string, unknown>[];
    // Both alpha and beta declare claude; discovery order is alphabetical.
    expect(claudePlugins).toStrictEqual([
      // alpha: description from config, tags from keywords, source = ./plugins/<name> POSIX.
      {
        name: 'alpha',
        source: './plugins/alpha',
        description: 'Alpha plugin',
        tags: ['a', 'b'],
      },
      // beta: description/tags keys OMITTED when absent (not serialized as undefined).
      { name: 'beta', source: './plugins/beta' },
    ]);

    // Cursor registry: only alpha declares cursor.
    const cursor = readJson(repo.repoRoot, ...CURSOR_REL) as Record<string, unknown>;
    expect(cursor['name']).toBe('my-market');
    expect(cursor['plugins']).toStrictEqual([
      { name: 'alpha', source: './plugins/alpha', description: 'Alpha plugin', tags: ['a', 'b'] },
    ]);
  });

  it('writes the Codex object-source registry with source/policy/category/interface', async () => {
    repo = synthRegistryRepo(
      [{ name: 'alpha', targets: ['codex'], meta: { description: 'Alpha', keywords: ['x'] } }],
      { name: 'my-market' },
    );

    await runBuild(repo.repoRoot);

    // spec §"Codex": { name, interface: { displayName }, plugins: [{ name, source: { source:'local',
    // path }, policy: { installation:'AVAILABLE', authentication:'ON_INSTALL' }, category }] }.
    const codex = readJson(repo.repoRoot, ...CODEX_REL) as Record<string, unknown>;
    expect(codex['name']).toBe('my-market');
    // displayName defaults to marketplace.name.
    expect(codex['interface']).toStrictEqual({ displayName: 'my-market' });
    expect(codex['plugins']).toStrictEqual([
      {
        name: 'alpha',
        source: { source: 'local', path: './plugins/alpha' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity', // default category
      },
    ]);
  });

  it('only generates registries for registry-backed targets present in some envelope', async () => {
    // vercel is not registry-backed and emits no mechanical bundle; a plugin declaring only it
    // produces NO marketplace.json files (and no claude/cursor/codex registry).
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['vercel'] }], { name: 'my-market' });

    await runBuild(repo.repoRoot);

    expect(fs.existsSync(path.join(repo.repoRoot, ...CLAUDE_REL))).toBe(false);
    expect(fs.existsSync(path.join(repo.repoRoot, ...CURSOR_REL))).toBe(false);
    expect(fs.existsSync(path.join(repo.repoRoot, ...CODEX_REL))).toBe(false);
  });

  it('generates only the Codex registry when only codex is registry-backed in the envelope set', async () => {
    // A plugin with codex + non-registry-backed vercel: only the Codex registry is written.
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['codex', 'vercel'] }], { name: 'm' });
    await runBuild(repo.repoRoot);

    expect(fs.existsSync(path.join(repo.repoRoot, ...CODEX_REL))).toBe(true);
    expect(fs.existsSync(path.join(repo.repoRoot, ...CLAUDE_REL))).toBe(false);
    expect(fs.existsSync(path.join(repo.repoRoot, ...CURSOR_REL))).toBe(false);
  });

  it('omits the top-level owner/metadata keys when the workspace omits them', async () => {
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude'] }], { name: 'minimal-market' });

    await runBuild(repo.repoRoot);

    const claude = readJson(repo.repoRoot, ...CLAUDE_REL) as Record<string, unknown>;
    expect(Object.keys(claude).sort()).toStrictEqual(['name', 'plugins']);
  });

  it('serializes registries as 2-space JSON with a trailing newline', async () => {
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude'] }], { name: 'm' });
    await runBuild(repo.repoRoot);
    const raw = fs.readFileSync(path.join(repo.repoRoot, ...CLAUDE_REL), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "name"'); // 2-space indentation
  });
});

describe('registry generation — freshness (workspace present)', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('a built repo validates clean with no registry freshness finding', async () => {
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude', 'cursor'] }], { name: 'm' });
    await runBuild(repo.repoRoot);
    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(result.findings, 'freshness')).toStrictEqual([]);
  });

  it('a hand-edited generated registry is a HARD freshness finding under ci:true', async () => {
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude'] }], { name: 'm' });
    await runBuild(repo.repoRoot);

    // Hand-edit the generated registry (change the source) — regeneration will diverge.
    const claudePath = path.join(repo.repoRoot, ...CLAUDE_REL);
    const obj = JSON.parse(fs.readFileSync(claudePath, 'utf-8')) as {
      plugins: { source: string }[];
    };
    const entry = obj.plugins[0];
    if (entry === undefined) throw new Error('fixture registry has no plugins');
    entry.source = './plugins/hand-edited';
    fs.writeFileSync(claudePath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh.every((f) => f.severity === 'hard')).toBe(true);
    expect(fresh.some((f) => f.message.includes('marketplace.json'))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('regenerating via build clears the freshness finding', async () => {
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude'] }], { name: 'm' });
    await runBuild(repo.repoRoot);

    const claudePath = path.join(repo.repoRoot, ...CLAUDE_REL);
    fs.appendFileSync(claudePath, ' ');
    const dirty = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(dirty.findings, 'freshness').length).toBeGreaterThanOrEqual(1);

    await runBuild(repo.repoRoot); // regenerate
    const clean = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(clean.findings, 'freshness')).toStrictEqual([]);
  });

  it('does NOT also emit marketplace-registration when generation is opted in', async () => {
    // Multi-target so the cross-target step (which would run marketplace-registration) is reached.
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude', 'cursor'] }], { name: 'm' });
    await runBuild(repo.repoRoot);
    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(result.findings, 'marketplace-registration')).toStrictEqual([]);
  });

  it('a missing generated registry is a freshness finding', async () => {
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude'] }], { name: 'm' });
    await runBuild(repo.repoRoot);
    fs.rmSync(path.join(repo.repoRoot, ...CLAUDE_REL));

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.some((f) => f.message.includes('missing'))).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('registry generation — backward compat (workspace absent)', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('generates no registries when no aipm.workspace.ts is present', async () => {
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude', 'cursor'] }]); // no workspace
    await runBuild(repo.repoRoot);

    expect(fs.existsSync(path.join(repo.repoRoot, ...CLAUDE_REL))).toBe(false);
    expect(fs.existsSync(path.join(repo.repoRoot, ...CURSOR_REL))).toBe(false);
  });

  it('still runs marketplace-registration (hand-authored path) when workspace is absent', async () => {
    // Multi-target, no workspace, no hand-authored registry files → the historical
    // marketplace-registration check fires (the plugin is not listed anywhere). This proves the
    // backward-compat path is intact and NOT subsumed when registries are not generated.
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['claude', 'cursor'] }]);
    await runBuild(repo.repoRoot);

    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(result.findings, 'marketplace-registration').length).toBeGreaterThanOrEqual(1);
    // And no registry freshness finding, since generation is opt-out here.
    const registryFresh = ofCode(result.findings, 'freshness').filter((f) =>
      f.message.includes('marketplace.json'),
    );
    expect(registryFresh).toStrictEqual([]);
  });
});

describe('registry generation — orphaned registries (target no longer declared)', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  // An orphan = a committed managed registry for a target NO plugin declares anymore (e.g. the
  // last `claude` plugin was dropped). It isn't in the "expected" set, so generation must remove
  // it and validation must flag it — otherwise a dead registry lingers committed with no signal.

  it('build removes an orphaned registry whose target no plugin declares', async () => {
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['cursor'] }], { name: 'm' });
    // Plant a previously-generated claude registry (no plugin declares claude now).
    const orphan = path.join(repo.repoRoot, ...CLAUDE_REL);
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, '{\n  "name": "m",\n  "plugins": []\n}\n', 'utf-8');

    await runBuild(repo.repoRoot);

    expect(fs.existsSync(orphan)).toBe(false); // removed
    expect(fs.existsSync(path.join(repo.repoRoot, ...CURSOR_REL))).toBe(true); // expected one kept
  });

  it('validate flags an orphaned registry as a freshness finding', async () => {
    repo = synthRegistryRepo([{ name: 'alpha', targets: ['cursor'] }], { name: 'm' });
    await runBuild(repo.repoRoot); // writes the expected cursor registry
    // Now plant an orphaned claude registry that `aipm build` would have removed.
    const orphan = path.join(repo.repoRoot, ...CLAUDE_REL);
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, '{\n  "name": "m",\n  "plugins": []\n}\n', 'utf-8');

    const result = await runValidate(repo.repoRoot, { ci: true });

    const orphanFinding = ofCode(result.findings, 'freshness').filter((f) =>
      f.message.includes('.claude-plugin/marketplace.json'),
    );
    expect(orphanFinding.length).toBe(1);
    expect(result.passed).toBe(false);
  });
});
