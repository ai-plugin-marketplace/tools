/**
 * Tests for per-target output of authored skill audience: what `runBuild` emits for each target
 * when a plugin's skills state `audience`, what it leaves alone when none does, and what a `hard`
 * finding stops.
 *
 * The integration suites build self-contained synth repos (no template checkout) through
 * `runBuild`/`runValidate`, so the projection, the per-target layout, registry generation, the
 * repo-root artifacts and the freshness check are exercised together with their real
 * implementations. Expectations are written from the specifications below, not from build output:
 *
 * - unified content model §5.1: who may invoke a skill per audience and host, the omit and widen
 *   fallbacks, and the `agent-only-` prefix rules; §5.3: the `audience` and `audience-fallback`
 *   keys exist only in the source and are removed from every host's output; §4: the
 *   implementation and fidelity vocabulary of an outcome.
 * - Claude Code: `disable-model-invocation: true` keeps the agent from invoking a skill,
 *   `user-invocable: false` keeps the user from invoking it.
 * - Codex: `policy.allow_implicit_invocation: false` in `agents/openai.yaml` beside the skill
 *   keeps the agent from selecting it.
 * - `HostFileChange` (normalizer): the contract of `write`, `remove` and `move`.
 *
 * @see https://github.com/ai-plugin-marketplace/normalizer/blob/main/docs/specs/unified-model.md
 * @see https://code.claude.com/docs/en/skills.md#control-who-invokes-a-skill
 * @see https://learn.chatgpt.com/docs/build-skills.md#optional-metadata
 * @see https://agentskills.io/specification
 * @see docs/specs/architecture.md §5.2 (build phase), §10.5 (freshness)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import type { HostFileChange } from '@ai-plugin-marketplace/normalizer';

import { runBuild } from './build.js';
import { applyHostFileChanges, computePluginHostForms, placeHostForm } from './host-forms.js';
import { runValidate } from './validate.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryRepo } from '../test-support/synth-plugin.js';
import type { BuildResult, Finding, FindingCode, HostBuildReport, TargetId } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLUGIN = 'demo';
const WORKSPACE = { name: 'audience-test-marketplace' } as const;

/** A `SKILL.md` with the Agent Skills floor (`name`, `description`) plus optional extra keys. */
function skillMd(name: string, extraFrontmatter = ''): string {
  return `---\nname: ${name}\ndescription: Use when testing the ${name} skill.\n${extraFrontmatter}---\n\n# ${name}\n\nBody of ${name}.\n`;
}

const MANIFEST = `${JSON.stringify({ name: PLUGIN, version: '0.0.1', description: 'A demo plugin.' }, null, 2)}\n`;

/** The minimum each target reads, so the plugin is valid for every target it declares. */
const TARGET_FILES: Record<string, string> = {
  '.claude-plugin/plugin.json': MANIFEST,
  '.codex-plugin/plugin.json': MANIFEST,
  '.cursor-plugin/plugin.json': MANIFEST,
  'gemini-extension.json': MANIFEST,
  'GEMINI.md': '# Demo\n',
  'POWER.md':
    '---\nname: demo\ndisplayName: Demo\ndescription: A demo plugin.\nversion: 0.0.1\nkeywords: [demo]\n---\n\n# Demo\n',
};

const TARGETS: readonly TargetId[] = ['claude', 'codex', 'cursor', 'gemini', 'kiro', 'vercel'];

/** One skill of each audience, plus an agent-only skill that opts into the prefix fallback. */
const AUDIENCE_SKILLS: Record<string, string> = {
  'skills/for-both/SKILL.md': skillMd('for-both'),
  'skills/for-user/SKILL.md': skillMd('for-user', 'audience: user\n'),
  'skills/for-agent/SKILL.md': skillMd('for-agent', 'audience: agent\n'),
  'skills/widened/SKILL.md': skillMd('widened', 'audience: agent\naudience-fallback: widen\n'),
};

/** The same four skills with no audience stated. */
const PLAIN_SKILLS: Record<string, string> = {
  'skills/for-both/SKILL.md': skillMd('for-both'),
  'skills/for-user/SKILL.md': skillMd('for-user'),
  'skills/for-agent/SKILL.md': skillMd('for-agent'),
  'skills/widened/SKILL.md': skillMd('widened'),
};

function synthRepo(
  skills: Record<string, string>,
  targets: readonly TargetId[] = TARGETS,
): SynthRegistryRepo {
  return synthRegistryRepo(
    [{ name: PLUGIN, targets, files: { ...TARGET_FILES, ...skills } }],
    WORKSPACE,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pluginDirOf(repo: SynthRegistryRepo): string {
  return path.join(repo.repoRoot, 'plugins', PLUGIN);
}

function distOf(repo: SynthRegistryRepo, target: TargetId): string {
  return path.join(repo.repoRoot, 'dist', target, PLUGIN);
}

/** Names of the entries of `<dir>/skills`, sorted; `undefined` when there is no such directory. */
function skillDirs(dir: string): string[] | undefined {
  const skillsDir = path.join(dir, 'skills');
  return fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : undefined;
}

/** The parsed YAML frontmatter of `<dir>/skills/<skill>/SKILL.md`. */
function frontmatter(dir: string, skill: string): Record<string, unknown> {
  const text = fs.readFileSync(path.join(dir, 'skills', skill, 'SKILL.md'), 'utf-8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match?.[1] === undefined) throw new Error(`no frontmatter in ${skill}`);
  return parseYaml(match[1]) as Record<string, unknown>;
}

/** Every file under `dir` as `relative POSIX path → bytes (base64)`, for whole-tree equality. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else
        out[path.relative(dir, abs).split(path.sep).join('/')] = fs
          .readFileSync(abs)
          .toString('base64');
    }
  };
  walk(dir);
  return out;
}

function readJson(...segments: string[]): unknown {
  return JSON.parse(fs.readFileSync(path.join(...segments), 'utf-8')) as unknown;
}

/** The `source` each string-source registry gives the plugin. */
function stringRegistrySource(repoRoot: string, ...rel: string[]): string | undefined {
  const registry = readJson(repoRoot, ...rel) as { plugins: { name: string; source: string }[] };
  return registry.plugins.find((p) => p.name === PLUGIN)?.source;
}

/** The `source.path` the Codex registry gives the plugin. */
function codexRegistryPath(repoRoot: string): string | undefined {
  const registry = readJson(repoRoot, '.agents', 'plugins', 'marketplace.json') as {
    plugins: { name: string; source: { source: string; path: string } }[];
  };
  return registry.plugins.find((p) => p.name === PLUGIN)?.source.path;
}

function ofCode(findings: readonly Finding[], code: FindingCode): Finding[] {
  return findings.filter((f) => f.code === code);
}

function hostReport(result: BuildResult | undefined, target: TargetId): HostBuildReport {
  const report = result?.hosts.find((h) => h.target === target);
  if (report === undefined) throw new Error(`no host report for ${target}`);
  return report;
}

/** `subject → "implementation [fidelity, …]"` for one target's outcomes. */
function outcomesBySkill(report: HostBuildReport): Record<string, string> {
  return Object.fromEntries(
    report.outcomes.map((o) => [o.subject, `${o.implementation} [${o.fidelity.join(', ')}]`]),
  );
}

const ALL_FOUR = ['for-agent', 'for-both', 'for-user', 'widened'];

// ---------------------------------------------------------------------------
// A plugin with one skill of each audience
// ---------------------------------------------------------------------------

describe('build of a plugin whose skills state an audience', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('leaves the authored source exactly as written', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    // The source keeps its declarations: only generated output differs per target.
    for (const [rel, content] of Object.entries(AUDIENCE_SKILLS)) {
      expect(fs.readFileSync(path.join(pluginDirOf(repo), rel), 'utf-8')).toBe(content);
    }
  });

  it('removes the source-only audience keys from every target (§5.3)', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    for (const target of TARGETS) {
      const dir = distOf(repo, target);
      for (const skill of skillDirs(dir) ?? []) {
        const keys = Object.keys(frontmatter(dir, skill));
        expect(keys, `${target}/${skill}`).not.toContain('audience');
        expect(keys, `${target}/${skill}`).not.toContain('audience-fallback');
      }
    }
  });

  it('emits Claude Code’s own audience controls (§5.1: native for every audience)', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    const dir = distOf(repo, 'claude');

    expect(skillDirs(dir)).toStrictEqual(ALL_FOUR);
    // user only → the agent may not invoke it.
    expect(frontmatter(dir, 'for-user')).toMatchObject({ 'disable-model-invocation': true });
    expect(frontmatter(dir, 'for-user')).not.toHaveProperty('user-invocable');
    // agent only → the user may not invoke it. `widen` is a fallback for hosts that cannot hide
    // the skill; Claude Code can, so the widened skill is restricted natively and keeps its name.
    for (const skill of ['for-agent', 'widened']) {
      expect(frontmatter(dir, skill)).toMatchObject({ name: skill, 'user-invocable': false });
      expect(frontmatter(dir, skill)).not.toHaveProperty('disable-model-invocation');
    }
    // both → neither control.
    expect(Object.keys(frontmatter(dir, 'for-both')).sort()).toStrictEqual(['description', 'name']);
  });

  it('emits Codex’s policy file, omits what it cannot hide, and prefixes on widen (§5.1)', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    const dir = distOf(repo, 'codex');

    // agent only, default fallback → omitted. agent only + widen → kept under `agent-only-`,
    // directory renamed with the skill.
    expect(skillDirs(dir)).toStrictEqual(['agent-only-widened', 'for-both', 'for-user']);
    expect(frontmatter(dir, 'agent-only-widened')).toMatchObject({ name: 'agent-only-widened' });

    // user only → native, through a generated agents/openai.yaml beside the skill.
    const policy = parseYaml(
      fs.readFileSync(path.join(dir, 'skills', 'for-user', 'agents', 'openai.yaml'), 'utf-8'),
    ) as unknown;
    expect(policy).toStrictEqual({ policy: { allow_implicit_invocation: false } });

    // Codex reads no audience control from frontmatter: only the floor remains.
    for (const skill of ['agent-only-widened', 'for-both', 'for-user']) {
      expect(Object.keys(frontmatter(dir, skill)).sort()).toStrictEqual(['description', 'name']);
    }
    // No policy file where no restriction applies.
    expect(fs.existsSync(path.join(dir, 'skills', 'for-both', 'agents'))).toBe(false);
  });

  it('gives a target outside the model every skill, without the source keys', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    for (const target of ['cursor', 'vercel'] as const) {
      const dir = distOf(repo, target);
      expect(skillDirs(dir), target).toStrictEqual(ALL_FOUR);
      for (const skill of ALL_FOUR) {
        expect(Object.keys(frontmatter(dir, skill)).sort(), `${target}/${skill}`).toStrictEqual([
          'description',
          'name',
        ]);
      }
    }
  });

  it('builds a per-target tree as the whole plugin, not only its skills', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    // A registry entry points at the tree, so the tree must hold what the host installs: its
    // manifest, byte-for-byte as authored.
    expect(
      fs.readFileSync(path.join(distOf(repo, 'claude'), '.claude-plugin', 'plugin.json'), 'utf-8'),
    ).toBe(MANIFEST);
    expect(
      fs.readFileSync(path.join(distOf(repo, 'codex'), '.codex-plugin', 'plugin.json'), 'utf-8'),
    ).toBe(MANIFEST);
  });

  it('applies the changes to the Gemini and Kiro bundles and their repo-root artifacts', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    for (const dir of [distOf(repo, 'gemini'), distOf(repo, 'kiro'), repo.repoRoot]) {
      expect(skillDirs(dir), dir).toStrictEqual(ALL_FOUR);
      for (const skill of ALL_FOUR) {
        expect(Object.keys(frontmatter(dir, skill)).sort(), `${dir}/${skill}`).toStrictEqual([
          'description',
          'name',
        ]);
      }
    }
    // Still a bundle, not a copy of the source: other targets' manifests are not in it.
    expect(fs.existsSync(path.join(distOf(repo, 'gemini'), '.claude-plugin'))).toBe(false);
    expect(fs.existsSync(path.join(distOf(repo, 'gemini'), 'gemini-extension.json'))).toBe(true);
  });

  it('points each registry entry at that target’s tree', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    expect(stringRegistrySource(repo.repoRoot, '.claude-plugin', 'marketplace.json')).toBe(
      './dist/claude/demo',
    );
    expect(stringRegistrySource(repo.repoRoot, '.cursor-plugin', 'marketplace.json')).toBe(
      './dist/cursor/demo',
    );
    expect(codexRegistryPath(repo.repoRoot)).toBe('./dist/codex/demo');
  });

  it('reports each target’s directory and one outcome per skill (§4)', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    const [result] = await runBuild(repo.repoRoot);

    expect(result?.hosts.map((h) => h.target)).toStrictEqual([...TARGETS]);
    for (const target of TARGETS) {
      expect(hostReport(result, target)).toMatchObject({
        status: 'projected',
        dir: distOf(repo, target),
      });
    }

    const claude = hostReport(result, 'claude');
    expect(claude.host).toBe('claude-code');
    expect(outcomesBySkill(claude)).toStrictEqual({
      'for-both': 'native []',
      'for-user': 'native []',
      'for-agent': 'native []',
      widened: 'native []',
    });

    const codex = hostReport(result, 'codex');
    expect(codex.host).toBe('codex');
    expect(outcomesBySkill(codex)).toStrictEqual({
      'for-both': 'native []',
      'for-user': 'native []',
      // §4: unavailable is always reported with exactly [omitted].
      'for-agent': 'unavailable [omitted]',
      // §5.1: the prefix fallback is a projection whose fidelity includes widened.
      widened: 'projection [widened]',
    });
    expect(codex.outcomes.every((o) => o.feature === 'skills.audience')).toBe(true);

    // A target the model does not cover reports no outcome and has no model host name.
    const cursor = hostReport(result, 'cursor');
    expect(cursor.outcomes).toStrictEqual([]);
    expect(cursor).not.toHaveProperty('host');
  });

  it('reports the losses as soft findings and passes validation', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    const result = await runValidate(repo.repoRoot, { ci: true });

    // §5.1: an omitted skill warns, naming the skill and the host.
    const omitted = ofCode(result.findings, 'skill-audience-omitted');
    expect(omitted).toHaveLength(1);
    expect(omitted[0]).toMatchObject({ severity: 'soft', plugin: PLUGIN });
    expect(omitted[0]?.message).toContain('for-agent');
    expect(omitted[0]?.message).toContain('Codex');

    const widened = ofCode(result.findings, 'skill-audience-widened');
    expect(widened).toHaveLength(1);
    expect(widened[0]).toMatchObject({ severity: 'soft', plugin: PLUGIN });
    expect(widened[0]?.message).toContain('widened');

    // Three restricted skills on each of the four targets outside the model.
    const unenforced = ofCode(result.findings, 'skill-audience-unenforced');
    expect(unenforced).toHaveLength(12);
    expect(unenforced.every((f) => f.severity === 'soft')).toBe(true);

    // Nothing is hard, and the freshly built trees and registries are fresh.
    expect(result.findings.filter((f) => f.severity === 'hard')).toStrictEqual([]);
    expect(ofCode(result.findings, 'freshness')).toStrictEqual([]);
    expect(result.passed).toBe(true);
  });

  it('flags a hand-edited per-target tree as stale', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    fs.appendFileSync(
      path.join(distOf(repo, 'codex'), 'skills', 'for-user', 'SKILL.md'),
      'edited\n',
    );

    const result = await runValidate(repo.repoRoot, { ci: true });
    const stale = ofCode(result.findings, 'freshness');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.message).toContain('dist/codex/demo/skills/for-user/SKILL.md');
    expect(result.passed).toBe(false);
  });

  it('flags trees and registries as stale once the source stops stating an audience, and a rebuild removes them', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    for (const [rel, content] of Object.entries(PLAIN_SKILLS)) {
      fs.writeFileSync(path.join(pluginDirOf(repo), rel), content);
    }

    const before = await runValidate(repo.repoRoot, { ci: true });
    const staleMessages = ofCode(before.findings, 'freshness').map((f) => f.message);
    for (const target of ['claude', 'codex', 'cursor', 'vercel']) {
      expect(staleMessages.some((m) => m.includes(`'dist/${target}/demo'`))).toBe(true);
    }
    expect(staleMessages.some((m) => m.includes('.claude-plugin/marketplace.json'))).toBe(true);

    const [result] = await runBuild(repo.repoRoot);
    for (const target of ['claude', 'codex', 'cursor', 'vercel'] as const) {
      expect(fs.existsSync(distOf(repo, target)), target).toBe(false);
      expect(hostReport(result, target)).toMatchObject({
        status: 'source',
        dir: pluginDirOf(repo),
      });
    }
    expect(stringRegistrySource(repo.repoRoot, '.claude-plugin', 'marketplace.json')).toBe(
      './plugins/demo',
    );
    expect(ofCode((await runValidate(repo.repoRoot, { ci: true })).findings, 'freshness')).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// A plugin that states no audience
// ---------------------------------------------------------------------------

describe('build of a plugin that states no audience', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('generates no per-target tree and leaves the plugin directory byte-identical', async () => {
    repo = synthRepo(PLAIN_SKILLS);
    const authored = snapshotTree(pluginDirOf(repo));
    await runBuild(repo.repoRoot);

    // No hooks are authored, so the build writes nothing into the plugin directory.
    expect(snapshotTree(pluginDirOf(repo))).toStrictEqual(authored);
    // Only the two bundled targets have anything under dist/.
    expect(fs.readdirSync(path.join(repo.repoRoot, 'dist')).sort()).toStrictEqual([
      'gemini',
      'kiro',
    ]);
  });

  it('keeps every registry entry pointing at the plugin directory', async () => {
    repo = synthRepo(PLAIN_SKILLS);
    await runBuild(repo.repoRoot);
    expect(stringRegistrySource(repo.repoRoot, '.claude-plugin', 'marketplace.json')).toBe(
      './plugins/demo',
    );
    expect(stringRegistrySource(repo.repoRoot, '.cursor-plugin', 'marketplace.json')).toBe(
      './plugins/demo',
    );
    expect(codexRegistryPath(repo.repoRoot)).toBe('./plugins/demo');
  });

  it('keeps the bundles’ skills byte-identical to the authored ones', async () => {
    repo = synthRepo(PLAIN_SKILLS);
    await runBuild(repo.repoRoot);
    for (const dir of [distOf(repo, 'gemini'), distOf(repo, 'kiro'), repo.repoRoot]) {
      for (const [rel, content] of Object.entries(PLAIN_SKILLS)) {
        expect(fs.readFileSync(path.join(dir, rel), 'utf-8'), `${dir}/${rel}`).toBe(content);
      }
    }
  });

  it('reports every target as built from the source, with no projection finding', async () => {
    repo = synthRepo(PLAIN_SKILLS);
    const [result] = await runBuild(repo.repoRoot);

    for (const target of ['claude', 'codex', 'cursor', 'vercel'] as const) {
      expect(hostReport(result, target)).toMatchObject({
        status: 'source',
        dir: pluginDirOf(repo),
      });
    }
    for (const target of ['gemini', 'kiro'] as const) {
      expect(hostReport(result, target)).toMatchObject({
        status: 'source',
        dir: distOf(repo, target),
      });
    }

    const validation = await runValidate(repo.repoRoot, { ci: true });
    expect(validation.findings).toStrictEqual([]);
    expect(validation.passed).toBe(true);
  });

  it('computes no change for any target', () => {
    repo = synthRepo(PLAIN_SKILLS);
    const forms = computePluginHostForms(pluginDirOf(repo), TARGETS);
    expect(forms.sourceFindings).toStrictEqual([]);
    expect(forms.hosts.map((h) => [h.target, h.changes.length, h.failed])).toStrictEqual(
      TARGETS.map((t) => [t, 0, false]),
    );
  });
});

// ---------------------------------------------------------------------------
// Hard findings
// ---------------------------------------------------------------------------

describe('a hard finding about one target', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  // §5.1: prefixing `foo` conflicts with an existing `agent-only-foo` skill, and the build fails
  // for that host. Only Codex needs the prefix; Claude Code restricts the skill natively.
  const COLLIDING_SKILLS: Record<string, string> = {
    'skills/foo/SKILL.md': skillMd('foo', 'audience: agent\naudience-fallback: widen\n'),
    'skills/agent-only-foo/SKILL.md': skillMd('agent-only-foo'),
  };
  const COLLISION_TARGETS: readonly TargetId[] = ['claude', 'codex'];

  it('stops that target and builds the others', async () => {
    repo = synthRepo(COLLIDING_SKILLS, COLLISION_TARGETS);
    const [result] = await runBuild(repo.repoRoot);

    // Codex: nothing emitted, and no registry lists the plugin for it.
    expect(fs.existsSync(distOf(repo, 'codex'))).toBe(false);
    expect(fs.existsSync(path.join(repo.repoRoot, '.agents', 'plugins', 'marketplace.json'))).toBe(
      false,
    );
    const codex = hostReport(result, 'codex');
    expect(codex.status).toBe('failed');
    expect(codex).not.toHaveProperty('dir');

    // Claude Code: built and listed as usual.
    expect(hostReport(result, 'claude')).toMatchObject({
      status: 'projected',
      dir: distOf(repo, 'claude'),
    });
    expect(skillDirs(distOf(repo, 'claude'))).toStrictEqual(['agent-only-foo', 'foo']);
    expect(frontmatter(distOf(repo, 'claude'), 'foo')).toMatchObject({ 'user-invocable': false });
    expect(stringRegistrySource(repo.repoRoot, '.claude-plugin', 'marketplace.json')).toBe(
      './dist/claude/demo',
    );
  });

  it('reports the hard finding, naming both skills, and fails validation', async () => {
    repo = synthRepo(COLLIDING_SKILLS, COLLISION_TARGETS);
    await runBuild(repo.repoRoot);
    const result = await runValidate(repo.repoRoot, { ci: true });

    const collisions = ofCode(result.findings, 'skill-audience-prefix-invalid');
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ severity: 'hard', plugin: PLUGIN });
    expect(collisions[0]?.message).toContain('foo');
    expect(collisions[0]?.message).toContain('agent-only-foo');
    expect(result.passed).toBe(false);
    // The failure is the finding, not drift: what the build left on disk is what it expects.
    expect(ofCode(result.findings, 'freshness')).toStrictEqual([]);
  });

  it('throws from a fail-fast build', async () => {
    repo = synthRepo(COLLIDING_SKILLS, COLLISION_TARGETS);
    await expect(runBuild(repo.repoRoot, { failFast: true })).rejects.toThrow(
      /skill-audience-prefix-invalid/,
    );
  });

  it('removes the tree an earlier, successful build left for the target', async () => {
    repo = synthRepo(
      { 'skills/foo/SKILL.md': skillMd('foo', 'audience: agent\naudience-fallback: widen\n') },
      COLLISION_TARGETS,
    );
    await runBuild(repo.repoRoot);
    expect(skillDirs(distOf(repo, 'codex'))).toStrictEqual(['agent-only-foo']);

    // The author adds a skill that takes the prefixed name.
    const colliding = path.join(pluginDirOf(repo), 'skills', 'agent-only-foo', 'SKILL.md');
    fs.mkdirSync(path.dirname(colliding), { recursive: true });
    fs.writeFileSync(colliding, skillMd('agent-only-foo'));
    await runBuild(repo.repoRoot);

    // A form that can no longer be built is not left published.
    expect(fs.existsSync(distOf(repo, 'codex'))).toBe(false);
  });
});

describe('a hard finding about the source', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  // §5.1: audience is `user | agent | both`. Any other value leaves the intended audience unknown.
  const INVALID_SKILLS: Record<string, string> = {
    'skills/for-both/SKILL.md': skillMd('for-both'),
    'skills/broken/SKILL.md': skillMd('broken', 'audience: everyone\n'),
  };

  it('stops every target of the plugin', async () => {
    repo = synthRepo(INVALID_SKILLS);
    const [result] = await runBuild(repo.repoRoot);

    for (const target of TARGETS) {
      const report = hostReport(result, target);
      expect(report.status, target).toBe('failed');
      expect(report, target).not.toHaveProperty('dir');
      expect(fs.existsSync(distOf(repo, target)), target).toBe(false);
    }
    // No registry lists a plugin that was built for no target, and the single-artifact hosts get
    // no repo-root artifact from it.
    for (const rel of [
      ['.claude-plugin', 'marketplace.json'],
      ['.cursor-plugin', 'marketplace.json'],
      ['.agents', 'plugins', 'marketplace.json'],
      ['gemini-extension.json'],
      ['POWER.md'],
      ['skills'],
    ]) {
      expect(fs.existsSync(path.join(repo.repoRoot, ...rel)), rel.join('/')).toBe(false);
    }
  });

  it('reports the hard finding, naming the skill, and fails validation', async () => {
    repo = synthRepo(INVALID_SKILLS);
    await runBuild(repo.repoRoot);
    const result = await runValidate(repo.repoRoot, { ci: true });

    const invalid = ofCode(result.findings, 'skill-audience-invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ severity: 'hard', plugin: PLUGIN });
    expect(invalid[0]?.message).toContain('broken');
    expect(result.passed).toBe(false);
  });

  it('does not stop a sibling plugin', async () => {
    repo = synthRegistryRepo(
      [
        { name: PLUGIN, targets: ['claude'], files: { ...TARGET_FILES, ...INVALID_SKILLS } },
        {
          name: 'sibling',
          targets: ['claude'],
          files: {
            '.claude-plugin/plugin.json': `${JSON.stringify({ name: 'sibling', version: '0.0.1' })}\n`,
            'skills/hello/SKILL.md': skillMd('hello'),
          },
        },
      ],
      WORKSPACE,
    );
    await runBuild(repo.repoRoot);

    const registry = readJson(repo.repoRoot, '.claude-plugin', 'marketplace.json') as {
      plugins: { name: string; source: string }[];
    };
    expect(registry.plugins).toStrictEqual([{ name: 'sibling', source: './plugins/sibling' }]);
  });
});

// ---------------------------------------------------------------------------
// The per-target layout
// ---------------------------------------------------------------------------

describe('placeHostForm', () => {
  const change: HostFileChange = { kind: 'remove', path: 'skills/a' };

  it('keeps a target on the authored directory while it needs no change', () => {
    for (const target of ['claude', 'codex', 'cursor', 'open-plugins', 'vercel'] as const) {
      expect(placeHostForm(target, false, []), target).toBe('source');
    }
  });

  it('gives a target its own tree once it needs a change', () => {
    for (const target of ['claude', 'codex', 'cursor', 'open-plugins', 'vercel'] as const) {
      expect(placeHostForm(target, false, [change]), target).toBe('tree');
    }
  });

  it('keeps Gemini and Kiro on their bundle either way', () => {
    for (const target of ['gemini', 'kiro'] as const) {
      expect(placeHostForm(target, false, []), target).toBe('bundle');
      expect(placeHostForm(target, false, [change]), target).toBe('bundle');
    }
  });

  it('places a failed target nowhere, whatever its changes', () => {
    for (const target of ['claude', 'gemini'] as const) {
      expect(placeHostForm(target, true, []), target).toBe('none');
      expect(placeHostForm(target, true, [change]), target).toBe('none');
    }
  });
});

// ---------------------------------------------------------------------------
// Applying changes
// ---------------------------------------------------------------------------

describe('applyHostFileChanges', () => {
  let root: string;
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(files: Record<string, string>): void {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-host-changes-'));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }

  const read = (rel: string): string =>
    fs.readFileSync(path.join(root, ...rel.split('/')), 'utf-8');
  const exists = (rel: string): boolean => fs.existsSync(path.join(root, ...rel.split('/')));

  it('write replaces a file’s content and creates missing parent directories', () => {
    seed({ 'skills/a/SKILL.md': 'old' });
    applyHostFileChanges(root, [
      { kind: 'write', path: 'skills/a/SKILL.md', content: 'new' },
      { kind: 'write', path: 'skills/a/agents/openai.yaml', content: 'policy: {}\n' },
    ]);
    expect(read('skills/a/SKILL.md')).toBe('new');
    expect(read('skills/a/agents/openai.yaml')).toBe('policy: {}\n');
  });

  it('write sets the stated permission bits on a new and on a replaced file', () => {
    seed({ 'bin/old': 'x' });
    applyHostFileChanges(root, [
      { kind: 'write', path: 'bin/new', content: '#!/bin/sh\n', mode: 0o755 },
      { kind: 'write', path: 'bin/old', content: '#!/bin/sh\n', mode: 0o755 },
    ]);
    expect(fs.statSync(path.join(root, 'bin', 'new')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(root, 'bin', 'old')).mode & 0o777).toBe(0o755);
  });

  it('remove deletes a file, or a directory and everything under it', () => {
    seed({ 'skills/a/SKILL.md': 'a', 'skills/a/ref/x.md': 'x', 'skills/b/SKILL.md': 'b' });
    applyHostFileChanges(root, [
      { kind: 'remove', path: 'skills/a' },
      { kind: 'remove', path: 'skills/b/SKILL.md' },
    ]);
    expect(exists('skills/a')).toBe(false);
    expect(exists('skills/b/SKILL.md')).toBe(false);
    expect(exists('skills/b')).toBe(true);
  });

  it('move relocates a directory with what is under it, and a later write names the new place', () => {
    seed({ 'skills/a/SKILL.md': 'a', 'skills/a/ref/x.md': 'x' });
    applyHostFileChanges(root, [
      { kind: 'move', from: 'skills/a', to: 'skills/agent-only-a' },
      { kind: 'write', path: 'skills/agent-only-a/SKILL.md', content: 'renamed' },
    ]);
    expect(exists('skills/a')).toBe(false);
    expect(read('skills/agent-only-a/SKILL.md')).toBe('renamed');
    expect(read('skills/agent-only-a/ref/x.md')).toBe('x');
  });

  it('refuses a move onto something that exists, leaving both in place', () => {
    seed({ 'skills/a/SKILL.md': 'a', 'skills/b/SKILL.md': 'b' });
    expect(() => {
      applyHostFileChanges(root, [{ kind: 'move', from: 'skills/a', to: 'skills/b' }]);
    }).toThrow(/already exists/);
    expect(read('skills/a/SKILL.md')).toBe('a');
    expect(read('skills/b/SKILL.md')).toBe('b');
  });

  it('refuses to remove or move a path that does not exist', () => {
    seed({ 'skills/a/SKILL.md': 'a' });
    expect(() => {
      applyHostFileChanges(root, [{ kind: 'remove', path: 'skills/missing' }]);
    }).toThrow(/does not exist/);
    expect(() => {
      applyHostFileChanges(root, [{ kind: 'move', from: 'skills/missing', to: 'skills/c' }]);
    }).toThrow(/does not exist/);
  });

  it('refuses a path that leaves the tree', () => {
    seed({ 'skills/a/SKILL.md': 'a' });
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
    for (const escaping of ['../' + path.basename(outside), outside, '']) {
      expect(() => {
        applyHostFileChanges(root, [{ kind: 'write', path: escaping, content: 'x' }]);
      }, JSON.stringify(escaping)).toThrow(/outside the plugin/);
    }
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('refuses a change of a kind it does not know rather than skipping it', () => {
    seed({ 'skills/a/SKILL.md': 'a' });
    const unknown = { kind: 'chmod', path: 'skills/a/SKILL.md' } as unknown as HostFileChange;
    expect(() => {
      applyHostFileChanges(root, [unknown, { kind: 'remove', path: 'skills/a' }]);
    }).toThrow(/Unknown host file change kind/);
    // Nothing after the unknown change was applied.
    expect(exists('skills/a/SKILL.md')).toBe(true);
  });
});
