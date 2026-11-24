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
 * - docs/specs/architecture.md §5.2.1: a plugin that states no audience builds as it did before;
 *   a target that cannot be built publishes nothing; the toolkit replaces, removes and reports
 *   only per-target trees its generated-trees manifest lists.
 * - Vercel Skills installs skills by scanning the repository's authored source, so no generated
 *   tree can be what it installs.
 *
 * - unified content model §4.2: a target the model does not cover yet (Cursor, Gemini CLI, Kiro,
 *   Open Plugins) cannot enforce an audience, so a skill restricted to the user or to the agent is
 *   left out there with a warning naming the skill and the target, and `audience-fallback: widen`
 *   does not apply. Vercel Skills is the exception, because it installs the authored source: the
 *   skill stays, with a warning that its restriction is not honoured.
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
import {
  applyHostFileChanges,
  computePluginHostForms,
  createHostFormsRun,
  placeHostForm,
  writeHostTree,
} from './host-forms.js';
import { runValidate, validateMarketplaceRegistration } from './validate.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryPlugin, SynthRegistryRepo } from '../test-support/synth-plugin.js';
import type { BuildResult, Finding, FindingCode, TargetBuildReport, TargetId } from './types.js';

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

function targetReport(result: BuildResult | undefined, target: TargetId): TargetBuildReport {
  const report = result?.targets.find((t) => t.target === target);
  if (report === undefined) throw new Error(`no report for ${target}`);
  return report;
}

/** `subject → "implementation [fidelity, …]"` for one target's outcomes. */
function outcomesBySkill(report: TargetBuildReport): Record<string, string> {
  return Object.fromEntries(
    report.outcomes.map((o) => [o.subject, `${o.implementation} [${o.fidelity.join(', ')}]`]),
  );
}

const ALL_FOUR = ['for-agent', 'for-both', 'for-user', 'widened'];

/** The skills of {@link AUDIENCE_SKILLS} that restrict who may invoke them. */
const RESTRICTED = ['for-agent', 'for-user', 'widened'];

/** The soft findings about `skill` on the target whose diagnostics name is `label`. */
function warningsAbout(findings: readonly Finding[], skill: string, label: string): Finding[] {
  return findings.filter(
    (f) => f.severity === 'soft' && f.message.includes(`"${skill}"`) && f.message.includes(label),
  );
}

/**
 * Asserts what a target outside the unified model gets in `dir` (§4.2): the unrestricted skill
 * only, with only the Agent Skills floor keys. Every restricted skill is left out, the one that
 * asks for `audience-fallback: widen` included, since that fallback does not apply there.
 */
function expectUncoveredTargetSkills(dir: string, where: string): void {
  expect(skillDirs(dir), where).toStrictEqual(['for-both']);
  expect(Object.keys(frontmatter(dir, 'for-both')).sort(), where).toStrictEqual([
    'description',
    'name',
  ]);
}

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

  it('gives a target outside the model its own tree, without the restricted skills (§4.2)', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    expectUncoveredTargetSkills(distOf(repo, 'cursor'), 'cursor');
  });

  it('leaves every restricted skill out of each target outside the model, widen included (§4.2)', () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    const uncovered = [
      ['cursor', 'Cursor'],
      ['gemini', 'Gemini CLI'],
      ['kiro', 'Kiro'],
      ['open-plugins', 'Open Plugins'],
    ] as const;
    const forms = computePluginHostForms(
      pluginDirOf(repo),
      uncovered.map(([target]) => target),
    );

    expect(forms.sourceFindings).toStrictEqual([]);
    for (const [target, label] of uncovered) {
      const form = forms.hosts.find((h) => h.target === target);
      expect(form, target).toMatchObject({ failed: false, outcomes: [] });
      expect(form, target).not.toHaveProperty('host');
      // Each restricted skill's directory is removed, and none is renamed under the prefix.
      const removed = (form?.changes ?? []).flatMap((c) => (c.kind === 'remove' ? [c.path] : []));
      expect(removed.sort(), target).toStrictEqual(RESTRICTED.map((skill) => `skills/${skill}`));
      expect(
        form?.changes.filter((c) => c.kind === 'move'),
        target,
      ).toStrictEqual([]);
      // One warning per skill left out, and nothing else: no skill is kept unenforced there.
      expect(
        form?.findings.map((f) => [f.code, f.severity]),
        target,
      ).toStrictEqual(RESTRICTED.map(() => ['skill-audience-omitted', 'soft']));
      for (const skill of RESTRICTED) {
        expect(
          warningsAbout(form?.findings ?? [], skill, label),
          `${skill} on ${label}`,
        ).toHaveLength(1);
      }
    }
  });

  it('builds nothing for Vercel, which installs the authored source', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    const [result] = await runBuild(repo.repoRoot);

    // No tree: nothing would install from it.
    expect(fs.existsSync(path.join(repo.repoRoot, 'dist', 'vercel'))).toBe(false);
    const vercel = targetReport(result, 'vercel');
    expect(vercel).toMatchObject({ status: 'authored', dir: pluginDirOf(repo) });
    expect(vercel.outcomes).toStrictEqual([]);
    expect(vercel).not.toHaveProperty('host');
  });

  it('warns about every restriction Vercel cannot honour', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    const result = await runValidate(repo.repoRoot, { ci: true });
    // The authored skills are what Vercel installs, restrictions unenforced: each one is reported.
    for (const skill of RESTRICTED) {
      const warnings = warningsAbout(result.findings, skill, 'Vercel');
      expect(warnings, skill).toHaveLength(1);
      expect(warnings[0], skill).toMatchObject({
        code: 'skill-audience-unenforced',
        plugin: PLUGIN,
      });
    }
    // Vercel is the only target where a restricted skill is kept unenforced (§4.2).
    expect(ofCode(result.findings, 'skill-audience-unenforced')).toHaveLength(RESTRICTED.length);
    expect(warningsAbout(result.findings, 'for-both', 'Vercel')).toStrictEqual([]);
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
      expectUncoveredTargetSkills(dir, dir);
    }
    // The repo-root artifact is the bundle: the same skills as under dist/.
    expect(skillDirs(repo.repoRoot)).toStrictEqual(skillDirs(distOf(repo, 'gemini')));
    expect(skillDirs(distOf(repo, 'kiro'))).toStrictEqual(skillDirs(distOf(repo, 'gemini')));
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

    expect(result?.targets.map((t) => t.target)).toStrictEqual([...TARGETS]);
    for (const target of ['claude', 'codex', 'cursor', 'gemini', 'kiro'] as const) {
      expect(targetReport(result, target)).toMatchObject({
        status: 'projected',
        dir: distOf(repo, target),
      });
    }

    const claude = targetReport(result, 'claude');
    expect(claude.host).toBe('claude-code');
    expect(outcomesBySkill(claude)).toStrictEqual({
      'for-both': 'native []',
      'for-user': 'native []',
      'for-agent': 'native []',
      widened: 'native []',
    });

    const codex = targetReport(result, 'codex');
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
    const cursor = targetReport(result, 'cursor');
    expect(cursor.outcomes).toStrictEqual([]);
    expect(cursor).not.toHaveProperty('host');
  });

  it('reports the losses as soft findings and passes validation', async () => {
    repo = synthRepo(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    const result = await runValidate(repo.repoRoot, { ci: true });

    // §5.1: an omitted skill warns, naming the skill and the host.
    const omitted = ofCode(result.findings, 'skill-audience-omitted').filter((f) =>
      f.message.includes('Codex'),
    );
    expect(omitted).toHaveLength(1);
    expect(omitted[0]).toMatchObject({ severity: 'soft', plugin: PLUGIN });
    expect(omitted[0]?.message).toContain('for-agent');
    expect(omitted[0]?.message).toContain('Codex');

    const widened = ofCode(result.findings, 'skill-audience-widened');
    expect(widened).toHaveLength(1);
    expect(widened[0]).toMatchObject({ severity: 'soft', plugin: PLUGIN });
    expect(widened[0]?.message).toContain('widened');

    // §4.2: a target outside the model cannot enforce an audience, so each restricted skill is
    // left out there, with exactly one warning naming the skill and the target.
    for (const label of ['Cursor', 'Gemini CLI', 'Kiro']) {
      for (const skill of RESTRICTED) {
        const warnings = warningsAbout(result.findings, skill, label);
        expect(warnings, `${skill} on ${label}`).toHaveLength(1);
        expect(warnings[0], `${skill} on ${label}`).toMatchObject({
          code: 'skill-audience-omitted',
          plugin: PLUGIN,
        });
      }
    }

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
    expect(stale[0]?.message).toContain("tree file 'dist/codex/demo/skills/for-user/SKILL.md'");
    expect(stale[0]?.hint).toContain('codex tree');
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
    for (const target of ['claude', 'codex', 'cursor']) {
      expect(staleMessages.some((m) => m.includes(`'dist/${target}/demo'`))).toBe(true);
    }
    expect(staleMessages.some((m) => m.includes('.claude-plugin/marketplace.json'))).toBe(true);

    const [result] = await runBuild(repo.repoRoot);
    for (const target of ['claude', 'codex', 'cursor'] as const) {
      // The tree goes, and so does the target's directory once nothing is left in it.
      expect(fs.existsSync(path.dirname(distOf(repo, target))), target).toBe(false);
      expect(targetReport(result, target)).toMatchObject({
        status: 'authored',
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
      expect(targetReport(result, target)).toMatchObject({
        status: 'authored',
        dir: pluginDirOf(repo),
      });
    }
    for (const target of ['gemini', 'kiro'] as const) {
      expect(targetReport(result, target)).toMatchObject({
        status: 'bundled',
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
    const codex = targetReport(result, 'codex');
    expect(codex.status).toBe('failed');
    expect(codex).not.toHaveProperty('dir');
    // §4, §5.1: the skill whose prefix could not be built is reported as left out of the host.
    expect(codex.host).toBe('codex');
    expect(outcomesBySkill(codex)['foo']).toBe('unavailable [omitted]');

    // Claude Code: built and listed as usual.
    expect(targetReport(result, 'claude')).toMatchObject({
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
      const report = targetReport(result, target);
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
    for (const target of ['claude', 'codex', 'cursor', 'open-plugins'] as const) {
      expect(placeHostForm(target, false, [change]), target).toBe('tree');
    }
  });

  it('keeps Vercel on the authored directory even when its form would differ', () => {
    // Vercel Skills scans the authored source; a generated tree would never be installed.
    expect(placeHostForm('vercel', false, [change])).toBe('source');
  });

  it('keeps Gemini and Kiro on their bundle either way', () => {
    for (const target of ['gemini', 'kiro'] as const) {
      expect(placeHostForm(target, false, []), target).toBe('bundle');
      expect(placeHostForm(target, false, [change]), target).toBe('bundle');
    }
  });

  it('places a failed target nowhere, whatever its changes', () => {
    for (const target of ['claude', 'gemini', 'vercel'] as const) {
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

  it('refuses to write through a link that leads out of the tree, leaving its target untouched', () => {
    // A tree keeps the plugin's links as written. One that points at an absolute path (here: a
    // directory standing in for the authored plugin) must not carry a change out of the tree.
    seed({ 'skills/a/SKILL.md': 'a' });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-host-changes-elsewhere-'));
    try {
      fs.mkdirSync(path.join(elsewhere, 'linked'));
      fs.writeFileSync(path.join(elsewhere, 'linked', 'SKILL.md'), 'authored');
      fs.symlinkSync(path.join(elsewhere, 'linked'), path.join(root, 'skills', 'linked'));
      fs.symlinkSync(
        path.join(elsewhere, 'linked', 'SKILL.md'),
        path.join(root, 'skills', 'a', 'LINKED.md'),
      );

      // Through a linked directory, to an existing file and to a new one; and through a linked file.
      for (const escaping of [
        'skills/linked/SKILL.md',
        'skills/linked/new.md',
        'skills/a/LINKED.md',
      ]) {
        expect(() => {
          applyHostFileChanges(root, [{ kind: 'write', path: escaping, content: 'changed' }]);
        }, escaping).toThrow(/through a link/);
      }
      expect(() => {
        applyHostFileChanges(root, [{ kind: 'remove', path: 'skills/linked/SKILL.md' }]);
      }).toThrow(/through a link/);

      expect(fs.readdirSync(path.join(elsewhere, 'linked'))).toStrictEqual(['SKILL.md']);
      expect(fs.readFileSync(path.join(elsewhere, 'linked', 'SKILL.md'), 'utf-8')).toBe('authored');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses to write through a link that leads nowhere, creating nothing at its target', () => {
    // Writing through a dangling link would create the file it names, wherever that is.
    seed({ 'skills/a/SKILL.md': 'a' });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-host-changes-elsewhere-'));
    try {
      const absoluteTarget = path.join(outsideDir, 'new.txt');
      fs.symlinkSync(absoluteTarget, path.join(root, 'skills', 'a', 'absolute.txt'));
      fs.symlinkSync(
        path.join('..', '..', '..', path.basename(outsideDir), 'relative.txt'),
        path.join(root, 'skills', 'a', 'relative.txt'),
      );
      // A dangling link whose target would be inside the tree is refused too: nothing a build
      // lays down is a link to a file that does not exist yet.
      fs.symlinkSync('missing.txt', path.join(root, 'skills', 'a', 'inside.txt'));

      for (const name of ['absolute.txt', 'relative.txt', 'inside.txt']) {
        expect(() => {
          applyHostFileChanges(root, [{ kind: 'write', path: `skills/a/${name}`, content: 'x' }]);
        }, name).toThrow(/link that leads nowhere/);
      }
      expect(fs.readdirSync(outsideDir)).toStrictEqual([]);
      expect(exists('skills/a/missing.txt')).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('removes a link itself, not what it points at', () => {
    seed({ 'shared/real/SKILL.md': 'real', 'skills/keep/SKILL.md': 'keep' });
    fs.symlinkSync(path.join('..', 'shared', 'real'), path.join(root, 'skills', 'linked'));
    applyHostFileChanges(root, [{ kind: 'remove', path: 'skills/linked' }]);
    expect(fs.lstatSync(path.join(root, 'skills', 'linked'), { throwIfNoEntry: false })).toBe(
      undefined,
    );
    expect(read('shared/real/SKILL.md')).toBe('real');
  });

  it('writes through a relative link that stays inside the tree', () => {
    seed({ 'shared/real/SKILL.md': 'real' });
    fs.mkdirSync(path.join(root, 'skills'));
    fs.symlinkSync(path.join('..', 'shared', 'real'), path.join(root, 'skills', 'linked'));
    applyHostFileChanges(root, [{ kind: 'write', path: 'skills/linked/SKILL.md', content: 'new' }]);
    expect(read('shared/real/SKILL.md')).toBe('new');
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

// ---------------------------------------------------------------------------
// A target's own tree
// ---------------------------------------------------------------------------

describe('writeHostTree', () => {
  let work: string;
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function seedPlugin(files: Record<string, string>): string {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-host-tree-'));
    const pluginDir = path.join(work, 'plugins', PLUGIN);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(pluginDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return pluginDir;
  }

  it('leaves a skill out of the tree when the target’s changes remove it, and keeps the rest', () => {
    // How a skill a target cannot restrict is left out: a `remove` of its directory.
    const pluginDir = seedPlugin({
      '.cursor-plugin/plugin.json': MANIFEST,
      'skills/for-both/SKILL.md': skillMd('for-both'),
      'skills/for-user/SKILL.md': skillMd('for-user', 'audience: user\n'),
      'skills/for-user/reference/notes.md': 'notes\n',
    });
    const authored = snapshotTree(pluginDir);
    const into = path.join(work, 'dist', 'cursor', PLUGIN);

    writeHostTree(
      pluginDir,
      into,
      [{ kind: 'remove', path: 'skills/for-user' }],
      path.join(work, 'dist'),
    );

    expect(snapshotTree(into)).toStrictEqual({
      '.cursor-plugin/plugin.json': authored['.cursor-plugin/plugin.json'],
      'skills/for-both/SKILL.md': authored['skills/for-both/SKILL.md'],
    });
    // The authored directory is the input, never the thing changed.
    expect(snapshotTree(pluginDir)).toStrictEqual(authored);
  });

  it('replaces what an earlier build left at the destination', () => {
    const pluginDir = seedPlugin({ 'skills/for-both/SKILL.md': skillMd('for-both') });
    const into = path.join(work, 'dist', 'cursor', PLUGIN);
    fs.mkdirSync(path.join(into, 'skills', 'gone'), { recursive: true });
    fs.writeFileSync(path.join(into, 'skills', 'gone', 'SKILL.md'), 'stale');

    writeHostTree(pluginDir, into, [], path.join(work, 'dist'));

    expect(Object.keys(snapshotTree(into))).toStrictEqual(['skills/for-both/SKILL.md']);
  });

  it('leaves out node_modules, .git and the dist root', () => {
    const pluginDir = seedPlugin({
      'skills/for-both/SKILL.md': skillMd('for-both'),
      'node_modules/dep/index.js': 'x',
      '.git/HEAD': 'ref',
      'dist/claude/demo/skills/for-both/SKILL.md': 'earlier output',
    });
    const into = path.join(work, 'out');

    writeHostTree(pluginDir, into, [], path.join(pluginDir, 'dist'));

    expect(Object.keys(snapshotTree(into))).toStrictEqual(['skills/for-both/SKILL.md']);
  });
});

// ---------------------------------------------------------------------------
// A skill directory that is a link
// ---------------------------------------------------------------------------

describe('build of a plugin whose restricted skill is a linked directory', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  const AUTHORED = skillMd('linked', 'audience: user\n');

  /** A Claude Code plugin whose `skills/linked` is a relative link to `shared/linked`. */
  function linkedSkillRepo(): SynthRegistryRepo {
    const synth = synthRepo({ 'shared/linked/SKILL.md': AUTHORED }, ['claude']);
    fs.mkdirSync(path.join(pluginDirOf(synth), 'skills'), { recursive: true });
    fs.symlinkSync(
      path.join('..', 'shared', 'linked'),
      path.join(pluginDirOf(synth), 'skills', 'linked'),
    );
    return synth;
  }

  it('restricts the skill in the tree and leaves the authored file as written', async () => {
    repo = linkedSkillRepo();
    await runBuild(repo.repoRoot);

    expect(frontmatter(distOf(repo, 'claude'), 'linked')).toStrictEqual({
      name: 'linked',
      description: 'Use when testing the linked skill.',
      'disable-model-invocation': true,
    });
    expect(
      fs.readFileSync(path.join(pluginDirOf(repo), 'shared', 'linked', 'SKILL.md'), 'utf-8'),
    ).toBe(AUTHORED);
  });

  // Regression: the freshness check read every entry of a tree as a file and failed with EISDIR
  // on a link to a directory, which a per-target tree keeps as the author wrote it.
  it('checks the freshness of a tree that holds a link to a directory', async () => {
    repo = linkedSkillRepo();
    await runBuild(repo.repoRoot);
    const fresh = await runValidate(repo.repoRoot, { ci: true });
    expect(ofCode(fresh.findings, 'freshness')).toStrictEqual([]);

    // Repointing the link in the generated tree is drift, and is named.
    const link = path.join(distOf(repo, 'claude'), 'skills', 'linked');
    fs.rmSync(link);
    fs.symlinkSync(path.join('..', 'shared'), link);
    const stale = ofCode((await runValidate(repo.repoRoot, { ci: true })).findings, 'freshness');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.message).toContain('dist/claude/demo/skills/linked');
  });
});

// ---------------------------------------------------------------------------
// Registries a repository writes by hand
// ---------------------------------------------------------------------------

describe('validateMarketplaceRegistration with a per-target tree', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  const REGISTRY_TARGETS: readonly TargetId[] = ['claude', 'codex'];

  /** The registration findings for the plugin, given its host forms as a run computes them. */
  function checkRegistration(synth: SynthRegistryRepo): Finding[] {
    const distDir = path.join(synth.repoRoot, 'dist');
    return validateMarketplaceRegistration(pluginDirOf(synth), synth.repoRoot, REGISTRY_TARGETS, {
      forms: createHostFormsRun(synth.repoRoot, distDir).forms(
        pluginDirOf(synth),
        REGISTRY_TARGETS,
      ),
      distDir,
    });
  }

  function rewriteClaudeSource(repoRoot: string, source: string): void {
    const file = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
    const registry = readJson(file) as { plugins: { name: string; source: string }[] };
    for (const entry of registry.plugins) entry.source = source;
    fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
  }

  it('accepts entries that point at each target’s tree', async () => {
    repo = synthRepo(AUDIENCE_SKILLS, REGISTRY_TARGETS);
    await runBuild(repo.repoRoot);
    expect(checkRegistration(repo)).toStrictEqual([]);
  });

  it('rejects an entry left on the authored directory, which would install without the changes', async () => {
    repo = synthRepo(AUDIENCE_SKILLS, REGISTRY_TARGETS);
    await runBuild(repo.repoRoot);
    rewriteClaudeSource(repo.repoRoot, './plugins/demo');

    const findings = checkRegistration(repo);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'hard',
      code: 'marketplace-registration',
      plugin: PLUGIN,
    });
    expect(findings[0]?.message).toContain("expected './dist/claude/demo'");
  });

  it('keeps expecting the authored directory for a plugin that states no audience', async () => {
    repo = synthRepo(PLAIN_SKILLS, REGISTRY_TARGETS);
    await runBuild(repo.repoRoot);
    expect(checkRegistration(repo)).toStrictEqual([]);

    rewriteClaudeSource(repo.repoRoot, './dist/claude/demo');
    const findings = checkRegistration(repo);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("expected './plugins/demo'");
  });

  // Regression: a failed target's entry was checked against the authored directory, so the hint
  // told the author to publish the source without the target's restrictions.
  it('says a plugin must not be listed for a target that could not be built', async () => {
    // No workspace: the registries are written by hand. Codex fails on the prefix collision.
    repo = synthRegistryRepo([
      {
        name: PLUGIN,
        targets: REGISTRY_TARGETS,
        files: {
          '.claude-plugin/plugin.json': MANIFEST,
          '.codex-plugin/plugin.json': MANIFEST,
          'skills/foo/SKILL.md': skillMd('foo', 'audience: agent\naudience-fallback: widen\n'),
          'skills/agent-only-foo/SKILL.md': skillMd('agent-only-foo'),
        },
      },
    ]);
    const writeRegistries = (codexListed: boolean): void => {
      const claude = path.join(repo?.repoRoot ?? '', '.claude-plugin', 'marketplace.json');
      fs.mkdirSync(path.dirname(claude), { recursive: true });
      fs.writeFileSync(
        claude,
        JSON.stringify({ name: 'm', plugins: [{ name: PLUGIN, source: './dist/claude/demo' }] }),
      );
      const codex = path.join(repo?.repoRoot ?? '', '.agents', 'plugins', 'marketplace.json');
      fs.mkdirSync(path.dirname(codex), { recursive: true });
      fs.writeFileSync(
        codex,
        JSON.stringify({
          name: 'm',
          plugins: codexListed
            ? [{ name: PLUGIN, source: { source: 'local', path: './dist/codex/demo' } }]
            : [],
        }),
      );
    };

    writeRegistries(true);
    await runBuild(repo.repoRoot);
    const listed = ofCode(
      (await runValidate(repo.repoRoot, { ci: true })).findings,
      'marketplace-registration',
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ severity: 'hard', plugin: PLUGIN });
    expect(listed[0]?.message).toContain("'codex' form could not be built");
    // Never a pointer at the authored directory, which carries none of the restrictions.
    expect(`${listed[0]?.message ?? ''} ${listed[0]?.hint ?? ''}`).not.toContain('./plugins/demo');

    // Unlisted, the failed target raises nothing here; Claude Code's entry on its tree is right.
    writeRegistries(false);
    expect(
      ofCode((await runValidate(repo.repoRoot, { ci: true })).findings, 'marketplace-registration'),
    ).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A plugin that states no audience, with a skill the projection cannot use
// ---------------------------------------------------------------------------

/** The files of a plugin for Claude Code and Codex only, plus `skills`. */
function twoTargetPlugin(skills: Record<string, string>): SynthRegistryRepo {
  return synthRegistryRepo(
    [
      {
        name: PLUGIN,
        targets: ['claude', 'codex'],
        files: {
          '.claude-plugin/plugin.json': MANIFEST,
          '.codex-plugin/plugin.json': MANIFEST,
          ...skills,
        },
      },
    ],
    WORKSPACE,
  );
}

/**
 * Four kinds of source the projection reports as a problem of the source itself, none of which
 * has anything to do with audience. `arrange` adds the problem to a built-up plugin directory.
 */
const UNUSABLE_SKILLS: readonly {
  name: string;
  code: FindingCode;
  arrange: (pluginDir: string, repoRoot: string) => void;
}[] = [
  {
    name: 'a skill directory linked from outside the plugin',
    code: 'source-unreadable',
    arrange: (pluginDir, repoRoot) => {
      const external = path.join(repoRoot, 'shared-skills', 'ext');
      fs.mkdirSync(external, { recursive: true });
      fs.writeFileSync(path.join(external, 'SKILL.md'), skillMd('ext'));
      fs.symlinkSync(
        path.join('..', '..', '..', 'shared-skills', 'ext'),
        path.join(pluginDir, 'skills', 'ext'),
      );
    },
  },
  {
    name: 'a SKILL.md that is a link to a file',
    code: 'source-unreadable',
    arrange: (pluginDir) => {
      fs.mkdirSync(path.join(pluginDir, 'shared'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'shared', 'linked.md'), skillMd('linked'));
      fs.mkdirSync(path.join(pluginDir, 'skills', 'linked'));
      fs.symlinkSync(
        path.join('..', '..', 'shared', 'linked.md'),
        path.join(pluginDir, 'skills', 'linked', 'SKILL.md'),
      );
    },
  },
  {
    name: 'a dangling link under skills/',
    code: 'source-unreadable',
    arrange: (pluginDir) => {
      fs.symlinkSync(path.join('..', 'nowhere'), path.join(pluginDir, 'skills', 'dangling'));
    },
  },
  {
    name: 'two skills that state the same name',
    code: 'skill-name-duplicate',
    arrange: (pluginDir) => {
      for (const dir of ['twin-a', 'twin-b']) {
        fs.mkdirSync(path.join(pluginDir, 'skills', dir));
        fs.writeFileSync(path.join(pluginDir, 'skills', dir, 'SKILL.md'), skillMd('twin'));
      }
    },
  },
];

describe('a skill the projection cannot use', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  describe.each(UNUSABLE_SKILLS)('$name', ({ code, arrange }) => {
    // Regression: any hard finding about the source failed every target, so a plugin that had
    // always built stopped building and left its registries.
    it('does not stop a plugin that states no audience: warning only, output as before', async () => {
      repo = twoTargetPlugin({ 'skills/plain/SKILL.md': skillMd('plain') });
      arrange(pluginDirOf(repo), repo.repoRoot);

      const [result] = await runBuild(repo.repoRoot, { failFast: false });

      for (const target of ['claude', 'codex'] as const) {
        expect(targetReport(result, target), target).toMatchObject({
          status: 'authored',
          dir: pluginDirOf(repo),
        });
      }
      expect(fs.existsSync(path.join(repo.repoRoot, 'dist'))).toBe(false);
      expect(stringRegistrySource(repo.repoRoot, '.claude-plugin', 'marketplace.json')).toBe(
        './plugins/demo',
      );
      expect(codexRegistryPath(repo.repoRoot)).toBe('./plugins/demo');

      const reported = ofCode((await runValidate(repo.repoRoot, { ci: true })).findings, code);
      expect(reported.length).toBeGreaterThan(0);
      expect(reported.map((f) => f.severity)).toStrictEqual(reported.map(() => 'soft'));
    });

    it('stops every target once another skill states an audience', async () => {
      repo = twoTargetPlugin({
        'skills/plain/SKILL.md': skillMd('plain'),
        'skills/restricted/SKILL.md': skillMd('restricted', 'audience: user\n'),
      });
      arrange(pluginDirOf(repo), repo.repoRoot);

      const [result] = await runBuild(repo.repoRoot);

      for (const target of ['claude', 'codex'] as const) {
        expect(targetReport(result, target).status, target).toBe('failed');
        expect(fs.existsSync(distOf(repo, target)), target).toBe(false);
      }
      expect(fs.existsSync(path.join(repo.repoRoot, '.claude-plugin', 'marketplace.json'))).toBe(
        false,
      );
      const validation = await runValidate(repo.repoRoot, { ci: true });
      expect(ofCode(validation.findings, code).some((f) => f.severity === 'hard')).toBe(true);
      expect(validation.passed).toBe(false);
    });
  });

  // Regression: any indented line starting `audience:` counted as stating an audience, so these
  // plugins, which state none, stopped building. Only a top-level frontmatter key is the source
  // key (unified model §5.3).
  it.each([
    [
      'a nested metadata.audience key',
      '---\nname: notes\ndescription: Use when testing the notes skill.\nmetadata:\n  audience: developers\n---\n\n# notes\n',
    ],
    [
      'a folded description whose second line starts "audience:"',
      '---\nname: notes\ndescription: >\n  Use when testing the notes skill. Its intended\n  audience: beginners who have not used it before.\n---\n\n# notes\n',
    ],
  ])('does not take %s for an audience declaration', async (_case, skillFile) => {
    repo = twoTargetPlugin({ 'skills/notes/SKILL.md': skillFile });
    UNUSABLE_SKILLS[0]?.arrange(pluginDirOf(repo), repo.repoRoot);

    const [result] = await runBuild(repo.repoRoot);

    for (const target of ['claude', 'codex'] as const) {
      expect(targetReport(result, target).status, target).toBe('authored');
    }
    expect(stringRegistrySource(repo.repoRoot, '.claude-plugin', 'marketplace.json')).toBe(
      './plugins/demo',
    );
    const unreadable = ofCode(
      (await runValidate(repo.repoRoot, { ci: true })).findings,
      'source-unreadable',
    );
    expect(unreadable.map((f) => f.severity)).toStrictEqual(unreadable.map(() => 'soft'));
  });

  it('still reads a top-level key in frontmatter that cannot be parsed', async () => {
    // A broken file must not hide a declaration: the key is at column 0, the YAML is invalid.
    repo = twoTargetPlugin({
      'skills/broken/SKILL.md':
        '---\nname: broken\ndescription: [unclosed\naudience: user\n---\n\n# broken\n',
    });
    UNUSABLE_SKILLS[0]?.arrange(pluginDirOf(repo), repo.repoRoot);
    const [result] = await runBuild(repo.repoRoot);
    expect(targetReport(result, 'claude').status).toBe('failed');
  });

  it('is not made strict by an audience another plugin states', async () => {
    // `skills/others` links to a sibling plugin's whole skills directory. Nothing there is a
    // skill of this plugin, so the sibling's restricted skill says nothing about this one.
    repo = synthRegistryRepo(
      [
        {
          name: PLUGIN,
          targets: ['claude'],
          files: {
            '.claude-plugin/plugin.json': MANIFEST,
            'skills/plain/SKILL.md': skillMd('plain'),
          },
        },
        {
          name: 'sibling',
          targets: ['claude'],
          files: {
            '.claude-plugin/plugin.json': `${JSON.stringify({ name: 'sibling', version: '0.0.1' })}\n`,
            'skills/restricted/SKILL.md': skillMd('restricted', 'audience: user\n'),
          },
        },
      ],
      WORKSPACE,
    );
    fs.symlinkSync(
      path.join('..', '..', 'sibling', 'skills'),
      path.join(pluginDirOf(repo), 'skills', 'others'),
    );

    const results = await runBuild(repo.repoRoot);

    expect(
      targetReport(
        results.find((r) => r.plugin === PLUGIN),
        'claude',
      ),
    ).toMatchObject({
      status: 'authored',
      dir: pluginDirOf(repo),
    });
    // The sibling's own audience is still built for the sibling.
    expect(
      targetReport(
        results.find((r) => r.plugin === 'sibling'),
        'claude',
      ).status,
    ).toBe('projected');
  });

  it('stays strict when the audience is stated in the very file that cannot be used', async () => {
    // The restriction is behind a linked SKILL.md, which the projection does not read. Treating
    // the plugin as stating no audience would publish the skill unrestricted.
    repo = twoTargetPlugin({ 'skills/plain/SKILL.md': skillMd('plain') });
    const pluginDir = pluginDirOf(repo);
    fs.mkdirSync(path.join(pluginDir, 'shared'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'shared', 'linked.md'),
      skillMd('linked', 'audience: user\n'),
    );
    fs.mkdirSync(path.join(pluginDir, 'skills', 'linked'));
    fs.symlinkSync(
      path.join('..', '..', 'shared', 'linked.md'),
      path.join(pluginDir, 'skills', 'linked', 'SKILL.md'),
    );

    const [result] = await runBuild(repo.repoRoot);
    expect(targetReport(result, 'claude').status).toBe('failed');
    expect(targetReport(result, 'codex').status).toBe('failed');
  });

  it('reports a SKILL.md with malformed frontmatter once', async () => {
    // Both the frontmatter check and the projection read this file; one report is enough.
    repo = twoTargetPlugin({
      'skills/bad/SKILL.md': '---\nname: bad\ndescription: [unclosed\n---\n\n# bad\n',
    });
    const about = (await runValidate(repo.repoRoot, { ci: true })).findings.filter((f) =>
      f.message.includes('skills/bad/SKILL.md'),
    );
    expect(about.map((f) => f.code)).toStrictEqual(['frontmatter-invalid']);
  });

  it('reports each skill of a shared name once per target', async () => {
    repo = twoTargetPlugin({});
    fs.mkdirSync(path.join(pluginDirOf(repo), 'skills'), { recursive: true });
    UNUSABLE_SKILLS[3]?.arrange(pluginDirOf(repo), repo.repoRoot);
    const [result] = await runBuild(repo.repoRoot);
    const twins = targetReport(result, 'claude').outcomes.filter((o) => o.subject === 'twin');
    expect(twins).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Changes that cannot be applied
// ---------------------------------------------------------------------------

describe('a target whose changes cannot be applied', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  const SIBLING = {
    name: 'sibling',
    targets: ['claude'] as const,
    files: {
      '.claude-plugin/plugin.json': `${JSON.stringify({ name: 'sibling', version: '0.0.1' })}\n`,
      'skills/hello/SKILL.md': skillMd('hello', 'audience: user\n'),
    },
  };
  const AUTHORED = skillMd('linked', 'audience: user\n');

  /** `demo` (Claude Code) with a restricted skill reached through `skills/linked`, and a sibling. */
  function repoWithLinkedSkill(linkTarget: (pluginDir: string) => string): SynthRegistryRepo {
    const synth = synthRegistryRepo(
      [
        {
          name: PLUGIN,
          targets: ['claude'],
          files: { '.claude-plugin/plugin.json': MANIFEST, 'shared/linked/SKILL.md': AUTHORED },
        },
        SIBLING,
      ],
      WORKSPACE,
    );
    const pluginDir = pluginDirOf(synth);
    fs.mkdirSync(path.join(pluginDir, 'skills'));
    fs.symlinkSync(linkTarget(pluginDir), path.join(pluginDir, 'skills', 'linked'));
    return synth;
  }

  const absoluteLink = (pluginDir: string): string => path.join(pluginDir, 'shared', 'linked');
  const relativeLink = (): string => path.join('..', 'shared', 'linked');

  // Regression: the refusal to write through an absolute link was thrown out of the build, which
  // stopped every plugin and left a half-written tree behind.
  it('fails that target with a finding, and builds the rest of the repo', async () => {
    repo = repoWithLinkedSkill(absoluteLink);

    const results = await runBuild(repo.repoRoot);

    const demo = results.find((r) => r.plugin === PLUGIN);
    expect(targetReport(demo, 'claude').status).toBe('failed');
    expect(fs.existsSync(distOf(repo, 'claude'))).toBe(false);
    // The authored skill was not written through the link.
    expect(
      fs.readFileSync(path.join(pluginDirOf(repo), 'shared', 'linked', 'SKILL.md'), 'utf-8'),
    ).toBe(AUTHORED);

    // The sibling is built and is the only plugin listed.
    const registry = readJson(repo.repoRoot, '.claude-plugin', 'marketplace.json') as {
      plugins: { name: string; source: string }[];
    };
    expect(registry.plugins).toStrictEqual([{ name: 'sibling', source: './dist/claude/sibling' }]);

    const validation = await runValidate(repo.repoRoot, { ci: true });
    const failures = validation.findings.filter(
      (f) => f.severity === 'hard' && f.plugin === PLUGIN && f.message.includes('through a link'),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("'claude' form");
    expect(validation.findings.filter((f) => f.plugin === 'sibling')).toStrictEqual([]);
    expect(ofCode(validation.findings, 'freshness')).toStrictEqual([]);
  });

  it('removes the tree an earlier, successful build left', async () => {
    repo = repoWithLinkedSkill(relativeLink);
    await runBuild(repo.repoRoot);
    expect(fs.existsSync(distOf(repo, 'claude'))).toBe(true);

    const link = path.join(pluginDirOf(repo), 'skills', 'linked');
    fs.rmSync(link);
    fs.symlinkSync(absoluteLink(pluginDirOf(repo)), link);
    await runBuild(repo.repoRoot);

    expect(fs.existsSync(distOf(repo, 'claude'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Which directories under the dist root are the toolkit's
// ---------------------------------------------------------------------------

describe('ownership of per-target trees', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  const manifestOf = (repoRoot: string): unknown =>
    readJson(repoRoot, '.aipm', 'generated-trees.json');

  function plantForeign(repoRoot: string, target: TargetId): string {
    const file = path.join(repoRoot, 'dist', target, PLUGIN, 'NOTES.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not generated\n');
    return file;
  }

  it('records the trees a build writes, and nothing for a plugin that needs none', async () => {
    repo = twoTargetPlugin(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    expect(manifestOf(repo.repoRoot)).toStrictEqual({
      version: 1,
      paths: ['dist/claude/demo', 'dist/codex/demo'],
    });

    const plain = twoTargetPlugin(PLAIN_SKILLS);
    try {
      await runBuild(plain.repoRoot);
      expect(fs.existsSync(path.join(plain.repoRoot, '.aipm'))).toBe(false);
    } finally {
      plain.cleanup();
    }
  });

  it('empties the record when the trees go', async () => {
    repo = twoTargetPlugin(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    for (const [rel, content] of Object.entries(PLAIN_SKILLS)) {
      fs.writeFileSync(path.join(pluginDirOf(repo), rel), content);
    }
    await runBuild(repo.repoRoot);
    expect(manifestOf(repo.repoRoot)).toStrictEqual({ version: 1, paths: [] });
  });

  it('neither removes nor reports a directory it did not write', async () => {
    // A plugin with no per-target tree, and directories at the paths trees would have.
    repo = twoTargetPlugin(PLAIN_SKILLS);
    const foreign = (['claude', 'codex', 'cursor', 'vercel'] as const).map((target) =>
      plantForeign(repo?.repoRoot ?? '', target),
    );

    await runBuild(repo.repoRoot);

    for (const file of foreign) expect(fs.readFileSync(file, 'utf-8')).toBe('not generated\n');
    expect(ofCode((await runValidate(repo.repoRoot, { ci: true })).findings, 'freshness')).toEqual(
      [],
    );
  });

  it('fails a target whose tree path holds a directory it did not write, and leaves it alone', async () => {
    repo = twoTargetPlugin(AUDIENCE_SKILLS);
    const foreign = plantForeign(repo.repoRoot, 'claude');

    const [result] = await runBuild(repo.repoRoot);

    expect(targetReport(result, 'claude').status).toBe('failed');
    expect(fs.readFileSync(foreign, 'utf-8')).toBe('not generated\n');
    expect(fs.readdirSync(distOf(repo, 'claude'))).toStrictEqual(['NOTES.md']);
    expect(fs.existsSync(path.join(repo.repoRoot, '.claude-plugin', 'marketplace.json'))).toBe(
      false,
    );
    // Codex is unaffected.
    expect(targetReport(result, 'codex').status).toBe('projected');
    expect(manifestOf(repo.repoRoot)).toStrictEqual({ version: 1, paths: ['dist/codex/demo'] });

    const collisions = ofCode(
      (await runValidate(repo.repoRoot, { ci: true })).findings,
      'generated-tree-collision',
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ severity: 'hard', plugin: PLUGIN });
    expect(collisions[0]?.message).toContain("'dist/claude/demo'");
    // The other way out, for a tree that was the toolkit's all along.
    expect(collisions[0]?.hint).toContain('.aipm/generated-trees.json');
  });

  // Regression: with the manifest lost or unreadable, every tree the toolkit had written counted
  // as a foreign directory, so the build failed those targets and took the plugin out of its
  // registries.
  it.each([
    [
      'is deleted',
      (file: string): void => {
        fs.rmSync(file);
      },
    ],
    [
      'holds merge conflict markers',
      (file: string): void => {
        fs.writeFileSync(file, '<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n');
      },
    ],
  ])('still owns its unchanged trees when the manifest %s', async (_case, damage) => {
    repo = twoTargetPlugin(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    const manifestFile = path.join(repo.repoRoot, '.aipm', 'generated-trees.json');
    damage(manifestFile);

    // Validation reports the manifest as out of date, not the trees as someone else's.
    const before = (await runValidate(repo.repoRoot, { ci: true })).findings;
    expect(ofCode(before, 'generated-tree-collision')).toStrictEqual([]);
    const stale = ofCode(before, 'freshness').map((f) => f.message);
    expect(stale.some((m) => m.includes("does not list 'dist/claude/demo'"))).toBe(true);

    // A build keeps every target published and writes the manifest again.
    const [result] = await runBuild(repo.repoRoot);
    expect(targetReport(result, 'claude').status).toBe('projected');
    expect(targetReport(result, 'codex').status).toBe('projected');
    expect(stringRegistrySource(repo.repoRoot, '.claude-plugin', 'marketplace.json')).toBe(
      './dist/claude/demo',
    );
    expect(manifestOf(repo.repoRoot)).toStrictEqual({
      version: 1,
      paths: ['dist/claude/demo', 'dist/codex/demo'],
    });
    expect(ofCode((await runValidate(repo.repoRoot, { ci: true })).findings, 'freshness')).toEqual(
      [],
    );
  });

  it('does not take an unlisted directory for its own once its content differs', async () => {
    repo = twoTargetPlugin(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    fs.rmSync(path.join(repo.repoRoot, '.aipm', 'generated-trees.json'));
    fs.appendFileSync(
      path.join(distOf(repo, 'claude'), 'skills', 'for-both', 'SKILL.md'),
      'edited\n',
    );

    const [result] = await runBuild(repo.repoRoot);
    expect(targetReport(result, 'claude').status).toBe('failed');
    expect(targetReport(result, 'codex').status).toBe('projected');
  });

  it('removes the trees of a plugin that is gone once every remaining plugin is built', async () => {
    const claudePlugin = (name: string, skills: Record<string, string>): SynthRegistryPlugin => ({
      name,
      targets: ['claude'],
      files: {
        '.claude-plugin/plugin.json': `${JSON.stringify({ name, version: '0.0.1' })}\n`,
        ...skills,
      },
    });
    const restricted = { 'skills/hello/SKILL.md': skillMd('hello', 'audience: user\n') };
    repo = synthRegistryRepo(
      [
        claudePlugin(PLUGIN, AUDIENCE_SKILLS),
        claudePlugin('other', restricted),
        claudePlugin('gone', restricted),
      ],
      WORKSPACE,
    );
    await runBuild(repo.repoRoot);
    fs.rmSync(path.join(repo.repoRoot, 'plugins', 'gone'), { recursive: true });
    const goneTree = path.join(repo.repoRoot, 'dist', 'claude', 'gone');

    // Building one of the two remaining plugins cannot tell a leftover from a sibling's tree, so
    // it keeps both the record and the directory.
    await runBuild(pluginDirOf(repo));
    expect(manifestOf(repo.repoRoot)).toStrictEqual({
      version: 1,
      paths: ['dist/claude/demo', 'dist/claude/gone', 'dist/claude/other'],
    });
    expect(fs.existsSync(goneTree)).toBe(true);

    // Validation says so, whichever plugin it was asked about.
    for (const target of [repo.repoRoot, pluginDirOf(repo)]) {
      const stale = ofCode((await runValidate(target, { ci: true })).findings, 'freshness');
      expect(
        stale.map((f) => f.message).filter((m) => m.includes("'dist/claude/gone'")),
      ).toHaveLength(1);
    }

    // A build that covers every plugin of the repo cleans up, whatever path it was given: with
    // `other` removed too, building `demo` alone is such a build.
    fs.rmSync(path.join(repo.repoRoot, 'plugins', 'other'), { recursive: true });
    await runBuild(pluginDirOf(repo));
    expect(fs.existsSync(goneTree)).toBe(false);
    expect(fs.existsSync(path.join(repo.repoRoot, 'dist', 'claude', 'other'))).toBe(false);
    expect(manifestOf(repo.repoRoot)).toStrictEqual({ version: 1, paths: ['dist/claude/demo'] });
    expect(ofCode((await runValidate(repo.repoRoot, { ci: true })).findings, 'freshness')).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Freshness of a generated tree
// ---------------------------------------------------------------------------

describe('freshness of a per-target tree', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  // Regression: only bytes were compared, so a tree that gained or lost an executable bit (which
  // a change can state, and which scripts in a tree depend on) counted as fresh.
  it('flags a file whose executable bit changed', async () => {
    repo = twoTargetPlugin(AUDIENCE_SKILLS);
    await runBuild(repo.repoRoot);
    const file = path.join(distOf(repo, 'claude'), 'skills', 'for-both', 'SKILL.md');
    fs.chmodSync(file, 0o755);

    const stale = ofCode((await runValidate(repo.repoRoot, { ci: true })).findings, 'freshness');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.message).toContain('dist/claude/demo/skills/for-both/SKILL.md');
  });

  it('names paths from the repo root when the dist root is relocated', async () => {
    repo = twoTargetPlugin(AUDIENCE_SKILLS);
    fs.writeFileSync(
      path.join(repo.repoRoot, 'aipm.repo.ts'),
      "export default { distDir: 'generated/out' };\n",
    );
    await runBuild(repo.repoRoot);
    const tree = path.join(repo.repoRoot, 'generated', 'out', 'codex', PLUGIN);
    fs.appendFileSync(path.join(tree, 'skills', 'for-user', 'SKILL.md'), 'edited\n');

    const stale = ofCode((await runValidate(repo.repoRoot, { ci: true })).findings, 'freshness');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.message).toContain("'generated/out/codex/demo/skills/for-user/SKILL.md'");

    // An orphaned tree is named the same way.
    for (const [rel, content] of Object.entries(PLAIN_SKILLS)) {
      fs.writeFileSync(path.join(pluginDirOf(repo), rel), content);
    }
    const orphaned = ofCode((await runValidate(repo.repoRoot, { ci: true })).findings, 'freshness')
      .map((f) => f.message)
      .filter((m) => m.includes('no longer produces'));
    expect(orphaned.some((m) => m.includes("'generated/out/claude/demo'"))).toBe(true);
    expect(orphaned.every((m) => !m.includes("'dist/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One projection per run
// ---------------------------------------------------------------------------

describe('createHostFormsRun', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
  });

  it('answers for a plugin once and reuses the answer for the rest of the run', () => {
    repo = twoTargetPlugin(AUDIENCE_SKILLS);
    const run = createHostFormsRun(repo.repoRoot, path.join(repo.repoRoot, 'dist'));
    const first = run.forms(pluginDirOf(repo), ['claude', 'codex']);

    // Even after the source changes: a run is one consistent view.
    fs.rmSync(path.join(pluginDirOf(repo), 'skills', 'for-user'), { recursive: true });
    expect(run.forms(pluginDirOf(repo), ['claude', 'codex'])).toBe(first);
    // A different envelope is a different question.
    expect(run.forms(pluginDirOf(repo), ['claude'])).not.toBe(first);
  });

  it('keeps the forms it produced only when asked, until it is disposed of', () => {
    repo = twoTargetPlugin(AUDIENCE_SKILLS);
    const distDir = path.join(repo.repoRoot, 'dist');

    const discarding = createHostFormsRun(repo.repoRoot, distDir);
    for (const form of discarding.forms(pluginDirOf(repo), ['claude', 'codex']).hosts) {
      expect(form, form.target).not.toHaveProperty('materialized');
    }

    const keeping = createHostFormsRun(repo.repoRoot, distDir, { keepMaterialized: true });
    const kept = keeping
      .forms(pluginDirOf(repo), ['claude', 'codex'])
      .hosts.map((form) => form.materialized);
    // What is kept is the target's form: Codex's has no agent-only skill it cannot hide.
    expect(skillDirs(kept[0] ?? '')).toStrictEqual(ALL_FOUR);
    expect(skillDirs(kept[1] ?? '')).toStrictEqual(['agent-only-widened', 'for-both', 'for-user']);

    keeping.dispose();
    for (const dir of kept) expect(fs.existsSync(dir ?? '')).toBe(false);
  });
});
