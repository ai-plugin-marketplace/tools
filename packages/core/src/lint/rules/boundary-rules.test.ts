/**
 * Positive/negative tests for the published-surface boundary rules (#118):
 * `unpublished-skill-installable`, `published-skill-internal`, `plugin-self-containment`,
 * `unpublished-skill-reference`.
 *
 * Expected values are derived from the spec's classification table and rule definitions, not from
 * the implementation's output. The `metadata.internal` values treated as "marked" are the ones the
 * `skills` CLI honors.
 *
 * @see docs/specs/lint-engine.md §3.2, L-D13 (skill classification), L-D7 (heuristic rules)
 * @see https://github.com/vercel-labs/skills (`metadata.internal` semantics)
 * @see https://agentskills.io/specification (SKILL.md frontmatter)
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runValidate } from '../../pipeline/validate.js';
import { createRuleContext } from '../context.js';
import { registeredRuleIds } from '../registered-rules.js';
import type { RuleContext } from '../types.js';
import { pluginSelfContainmentRule } from './plugin-self-containment.js';
import {
  publishedSkillInternalRule,
  unpublishedSkillInstallableRule,
} from './skill-internal-marker.js';
import { unpublishedSkillReferenceRule } from './unpublished-skill-reference.js';

const md = String.raw;

let repoRoot: string;

beforeEach(() => {
  // realpath: macOS tmpdir is a symlink, and git reports paths relative to the resolved cwd.
  repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-boundary-rules-')));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function write(rel: string, content: string | object): void {
  const full = path.join(repoRoot, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    'utf-8',
  );
}

/** A minimal SKILL.md; `extraFrontmatter` is appended verbatim inside the frontmatter block. */
function skill(name: string, extraFrontmatter = '', body = 'Body.\n'): string {
  return `---\nname: ${name}\ndescription: Use when testing.\n${extraFrontmatter}---\n\n${body}`;
}

/** A published plugin at `plugins/<plugin>` holding one skill named after the plugin. */
function writePublishedPlugin(plugin: string, skillBody?: string): void {
  write(`plugins/${plugin}/.claude-plugin/plugin.json`, { name: plugin });
  write(`plugins/${plugin}/skills/${plugin}/SKILL.md`, skill(plugin, '', skillBody));
}

/** Repo-level context, as `lint()`/`validate()` build for repo-scoped rules. */
function repoCtx(): RuleContext {
  const pluginsDir = path.join(repoRoot, 'plugins');
  const allPluginDirs = fs.existsSync(pluginsDir)
    ? fs.readdirSync(pluginsDir).map((name) => path.join(pluginsDir, name))
    : [];
  return createRuleContext({
    pluginDir: repoRoot,
    repoRoot,
    distDir: path.join(repoRoot, 'dist'),
    envelope: [],
    allPluginDirs,
    workspace: undefined,
    ci: false,
  });
}

function pluginCtx(plugin: string): RuleContext {
  return createRuleContext({
    pluginDir: path.join(repoRoot, 'plugins', plugin),
    repoRoot,
    distDir: path.join(repoRoot, 'dist'),
    envelope: ['claude'],
    workspace: undefined,
    ci: false,
  });
}

describe('correctness/unpublished-skill-installable', () => {
  it('flags a skill outside every published plugin that lacks metadata.internal (#118)', async () => {
    writePublishedPlugin('user-plugin');
    write('.claude/skills/release/SKILL.md', skill('release'));

    const diagnostics = await unpublishedSkillInstallableRule.check(repoCtx());

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      ruleId: 'correctness/unpublished-skill-installable',
      category: 'correctness',
      severity: 'error', // L-D13: an unmarked unpublished skill is an `error`
      file: '.claude/skills/release/SKILL.md', // L-D13: `file` is the skill, repo-relative
      legacyCode: 'unpublished-skill-installable', // §3.6 migration table
    });
    // L-D13: the message names the file; the hint names both resolutions.
    expect(diagnostics[0]?.message).toContain('.claude/skills/release/SKILL.md');
    expect(diagnostics[0]?.hint).toContain('internal: true');
    expect(diagnostics[0]?.hint).toContain('move it into');
  });

  it.each([
    ['boolean true', 'metadata:\n  internal: true\n'],
    ['string "true"', 'metadata:\n  internal: "true"\n'],
    ['string "1"', 'metadata:\n  internal: "1"\n'],
  ])('accepts metadata.internal as %s', async (_label, frontmatter) => {
    writePublishedPlugin('user-plugin');
    write('.claude/skills/release/SKILL.md', skill('release', frontmatter));

    expect(await unpublishedSkillInstallableRule.check(repoCtx())).toEqual([]);
  });

  it.each([
    ['internal: false', 'metadata:\n  internal: false\n'],
    ['a metadata block without internal', 'metadata:\n  author: someone\n'],
    ['a top-level internal key', 'internal: true\n'],
  ])('does not accept %s as the marker', async (_label, frontmatter) => {
    writePublishedPlugin('user-plugin');
    write('.claude/skills/release/SKILL.md', skill('release', frontmatter));

    expect(await unpublishedSkillInstallableRule.check(repoCtx())).toHaveLength(1);
  });

  it('flags an unpublished SKILL.md that has no frontmatter at all', async () => {
    writePublishedPlugin('user-plugin');
    write('.agents/skills/notes/SKILL.md', '# Notes\n');

    const diagnostics = await unpublishedSkillInstallableRule.check(repoCtx());
    expect(diagnostics.map((d) => d.file)).toEqual(['.agents/skills/notes/SKILL.md']);
  });

  it('never flags a skill inside a published plugin', async () => {
    writePublishedPlugin('user-plugin');

    expect(await unpublishedSkillInstallableRule.check(repoCtx())).toEqual([]);
  });

  it('exempts generated copies under the dist root', async () => {
    writePublishedPlugin('user-plugin');
    write('dist/gemini/user-plugin/skills/user-plugin/SKILL.md', skill('user-plugin'));

    expect(await unpublishedSkillInstallableRule.check(repoCtx())).toEqual([]);
  });

  it('exempts a repo-root skill only when the generated-root sidecar lists it', async () => {
    writePublishedPlugin('user-plugin');
    write('skills/user-plugin/SKILL.md', skill('user-plugin'));

    // Not tracked by the sidecar: an authored repo-root skill, so it is unpublished.
    expect((await unpublishedSkillInstallableRule.check(repoCtx())).map((d) => d.file)).toEqual([
      'skills/user-plugin/SKILL.md',
    ]);

    write('.aipm/generated-root.json', { version: 1, paths: ['skills/user-plugin/SKILL.md'] });
    expect(await unpublishedSkillInstallableRule.check(repoCtx())).toEqual([]);
  });

  it('skips dependency trees', async () => {
    writePublishedPlugin('user-plugin');
    write('node_modules/some-pkg/skills/vendored/SKILL.md', skill('vendored'));

    expect(await unpublishedSkillInstallableRule.check(repoCtx())).toEqual([]);
  });

  it('skips paths git ignores, and still sees untracked non-ignored skills', async () => {
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    write('.gitignore', 'scratch/\n');
    writePublishedPlugin('user-plugin');
    write('scratch/skills/draft/SKILL.md', skill('draft'));
    write('.claude/skills/release/SKILL.md', skill('release'));

    const diagnostics = await unpublishedSkillInstallableRule.check(repoCtx());
    expect(diagnostics.map((d) => d.file)).toEqual(['.claude/skills/release/SKILL.md']);
  });

  it('is a no-op when the directory is not an aipm repo root', async () => {
    // No plugins root and no aipm.repo.ts: there is no published surface to classify against.
    write('.claude/skills/release/SKILL.md', skill('release'));

    expect(await unpublishedSkillInstallableRule.check(repoCtx())).toEqual([]);
  });

  it('fails validate() with a hard finding, and passes that check once marked (#118)', async () => {
    writePublishedPlugin('user-plugin');
    write('.claude/skills/release/SKILL.md', skill('release'));

    const before = await runValidate(repoRoot);
    const leak = before.findings.filter((f) => f.code === 'unpublished-skill-installable');
    expect(leak).toHaveLength(1);
    expect(leak[0]?.severity).toBe('hard');
    expect(leak[0]?.message).toContain('.claude/skills/release/SKILL.md');
    expect(before.passed).toBe(false);

    write('.claude/skills/release/SKILL.md', skill('release', 'metadata:\n  internal: true\n'));
    const after = await runValidate(repoRoot);
    expect(after.findings.filter((f) => f.code === 'unpublished-skill-installable')).toEqual([]);
  });
});

describe('correctness/published-skill-internal', () => {
  it('warns when a published skill is marked internal, pointing at the field', async () => {
    write('plugins/user-plugin/.claude-plugin/plugin.json', { name: 'user-plugin' });
    write(
      'plugins/user-plugin/skills/user-plugin/SKILL.md',
      skill('user-plugin', 'metadata:\n  internal: true\n'),
    );

    const diagnostics = await publishedSkillInternalRule.check(repoCtx());

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      ruleId: 'correctness/published-skill-internal',
      severity: 'warn', // §3.2: default severity `warn`
      file: 'plugins/user-plugin/skills/user-plugin/SKILL.md',
    });
    // Frontmatter line 5 is `  internal: true` (after `---`, name, description, `metadata:`).
    expect(diagnostics[0]?.range?.start.line).toBe(5);
    expect(diagnostics[0]?.legacyCode).toBeUndefined();
  });

  it('is silent for an unmarked published skill and for a marked unpublished one', async () => {
    writePublishedPlugin('user-plugin');
    write('.claude/skills/release/SKILL.md', skill('release', 'metadata:\n  internal: true\n'));

    expect(await publishedSkillInternalRule.check(repoCtx())).toEqual([]);
  });
});

describe('correctness/plugin-self-containment', () => {
  it('is silent when every reference stays inside the plugin', async () => {
    write('plugins/p/.claude-plugin/plugin.json', { name: 'p', agents: './agents/a.md' });
    write('plugins/p/agents/a.md', '---\nname: a\ndescription: d\n---\n');
    write('plugins/p/skills/p/reference.md', '# Reference\n');
    write(
      'plugins/p/skills/p/SKILL.md',
      skill(
        'p',
        '',
        md`
See [the reference](./reference.md#section), [the agent](../../agents/a.md),
[the docs](https://example.com/docs), [an anchor](#usage) and [mail](mailto:a@example.com).
        `,
      ),
    );

    expect(await pluginSelfContainmentRule.check(pluginCtx('p'))).toEqual([]);
  });

  it('flags a manifest path field that climbs out of the plugin', async () => {
    write('plugins/p/.claude-plugin/plugin.json', { name: 'p', agents: '../shared/agents' });

    const diagnostics = await pluginSelfContainmentRule.check(pluginCtx('p'));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      ruleId: 'correctness/plugin-self-containment',
      severity: 'error', // §3.2: default severity `error`
      file: '.claude-plugin/plugin.json',
    });
    expect(diagnostics[0]?.message).toContain("'../shared/agents'");
    expect(diagnostics[0]?.range).toBeDefined();
  });

  it('flags a markdown link from a published skill into a contributor skill folder', async () => {
    write('.claude/skills/release/SKILL.md', skill('release', 'metadata:\n  internal: true\n'));
    write(
      'plugins/p/skills/p/SKILL.md',
      skill('p', '', 'Follow [the release steps](../../../../.claude/skills/release/SKILL.md).\n'),
    );

    const diagnostics = await pluginSelfContainmentRule.check(pluginCtx('p'));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      ruleId: 'correctness/plugin-self-containment',
      severity: 'error',
      file: 'skills/p/SKILL.md',
    });
    // Frontmatter is lines 1-4, line 5 is blank, the link is on line 6; `Follow [the release
    // steps](` is 27 characters, so the target starts at column 28.
    expect(diagnostics[0]?.range?.start).toEqual({ line: 6, col: 28 });
  });

  it('flags an escaping reference-style link definition', async () => {
    write(
      'plugins/p/skills/p/SKILL.md',
      skill('p', '', 'See [guide].\n\n[guide]: ../../../docs/guide.md\n'),
    );

    const diagnostics = await pluginSelfContainmentRule.check(pluginCtx('p'));
    expect(diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining("'../../../docs/guide.md'"),
    ]);
  });

  it('ignores links inside fenced code blocks', async () => {
    write(
      'plugins/p/skills/p/SKILL.md',
      skill('p', '', '```md\n[example](../../../outside.md)\n```\n'),
    );

    expect(await pluginSelfContainmentRule.check(pluginCtx('p'))).toEqual([]);
  });
});

describe('correctness/unpublished-skill-reference', () => {
  it('warns when a published skill names an unpublished skill', async () => {
    writePublishedPlugin('user-plugin', 'Before shipping, run the release-checklist skill.\n');
    write(
      '.claude/skills/release-checklist/SKILL.md',
      skill('release-checklist', 'metadata:\n  internal: true\n'),
    );

    const diagnostics = await unpublishedSkillReferenceRule.check(repoCtx());

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      ruleId: 'correctness/unpublished-skill-reference',
      severity: 'warn', // L-D7: heuristic rules default to a non-blocking severity
      file: 'plugins/user-plugin/skills/user-plugin/SKILL.md',
    });
    expect(diagnostics[0]?.message).toContain("'release-checklist'");
    // Line 6 of the file; `Before shipping, run the ` is 25 characters.
    expect(diagnostics[0]?.range?.start).toEqual({ line: 6, col: 26 });
  });

  it('does not match an unpublished name inside a longer identifier', async () => {
    writePublishedPlugin(
      'user-plugin',
      'Write the pre-release notes and the release-notes file.\n',
    );
    write('.claude/skills/release/SKILL.md', skill('release', 'metadata:\n  internal: true\n'));

    expect(await unpublishedSkillReferenceRule.check(repoCtx())).toEqual([]);
  });

  it('ignores a name that a published skill also uses', async () => {
    writePublishedPlugin('user-plugin', 'This is the user-plugin skill.\n');
    write(
      '.claude/skills/user-plugin/SKILL.md',
      skill('user-plugin', 'metadata:\n  internal: true\n'),
    );

    expect(await unpublishedSkillReferenceRule.check(repoCtx())).toEqual([]);
  });
});

describe('rule registry (§3.6)', () => {
  it('registers the four boundary rules', () => {
    expect(registeredRuleIds()).toEqual(
      expect.arrayContaining([
        'correctness/unpublished-skill-installable',
        'correctness/published-skill-internal',
        'correctness/plugin-self-containment',
        'correctness/unpublished-skill-reference',
      ]),
    );
    // §3.6: the rule table matches ALL_RULES exactly — 20 registered rules.
    expect(registeredRuleIds()).toHaveLength(20);
  });
});
