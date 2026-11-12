/**
 * Subprocess UAT for the published-surface boundary (#118): a repo with one published plugin and
 * one contributor-only skill in a host's project-local folder.
 *
 * Drives the two real user interfaces involved:
 *
 * - the built `aipm` CLI (`dist/bin.js`), for `init` / `scaffold` / `build` / `validate` / `lint`;
 * - the real `skills` CLI (a pinned devDependency), whose `add <path> --list` is the install
 *   channel that ignores `aipm`'s registries and scans the repository for `SKILL.md` files.
 *
 * The `skills` CLI is run against a local path with its telemetry disabled, so the listing needs
 * no network access.
 *
 * @see docs/specs/lint-engine.md §3.2, L-D13
 * @see https://github.com/vercel-labs/skills (`add --list`, `metadata.internal`, `DISABLE_TELEMETRY`)
 * @see https://agentskills.io/specification (SKILL.md frontmatter)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(CLI_DIR, 'dist', 'bin.js');

/** The `skills` CLI entry point, resolved from this package's own devDependency. */
const SKILLS_BIN_PATH = path.join(
  path.dirname(createRequire(import.meta.url).resolve('skills/package.json')),
  'bin',
  'cli.mjs',
);

const PUBLISHED_SKILL = 'user-plugin';
const CONTRIBUTOR_SKILL = 'release-runbook';
const CONTRIBUTOR_SKILL_REL = `.claude/skills/${CONTRIBUTOR_SKILL}/SKILL.md`;

/** Every registry `aipm build` can generate, relative to the repo root. */
const REGISTRY_REL_PATHS = [
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
  'marketplace.json',
];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runAipm(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Every skill name the `skills` CLI offers for `repo`, as a user running
 * `npx skills add <repo> --list` would see them, sorted. In its "Available Skills" block each
 * name sits on its own line indented four spaces after the gutter (descriptions are indented
 * six), so the whole offered set is read rather than probing for expected names — an unexpected
 * extra skill fails the assertion. ANSI styling is stripped first.
 */
function listOfferedSkills(repo: string): string[] {
  const result = spawnSync(process.execPath, [SKILLS_BIN_PATH, 'add', repo, '--list'], {
    cwd: repo,
    encoding: 'utf-8',
    env: { ...process.env, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1', CI: '1' },
  });
  expect(result.status, `skills CLI failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  // eslint-disable-next-line no-control-regex -- stripping ANSI escape sequences from CLI output
  const plain = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  const block = plain.slice(plain.indexOf('Available Skills'));
  return [...block.matchAll(/^│ {4}(\S+)[ \t]*$/gm)].map((match) => match[1] ?? '').sort();
}

function skillMd(name: string, description: string, extraFrontmatter = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n# ${name}\n`;
}

let repo: string;

beforeAll(() => {
  // Real build, so the subprocess runs the same compiled artifact a real install would.
  execFileSync('pnpm', ['exec', 'tsc', '--build'], { cwd: CLI_DIR, stdio: 'inherit' });

  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-surface-uat-')));
  repo = path.join(parent, 'repo');
  expect(runAipm(['init', repo], parent).code).toBe(0);
  // A real marketplace repo is a git repository; this also exercises the rule's git-based
  // enumeration against the real `skills` CLI.
  execFileSync('git', ['init', '-q'], { cwd: repo });
  expect(runAipm(['scaffold', PUBLISHED_SKILL], repo).code).toBe(0);
  // The published plugin's one user-facing skill.
  const publishedSkillPath = path.join(
    repo,
    'plugins',
    PUBLISHED_SKILL,
    'skills',
    PUBLISHED_SKILL,
    'SKILL.md',
  );
  fs.mkdirSync(path.dirname(publishedSkillPath), { recursive: true });
  fs.writeFileSync(publishedSkillPath, skillMd(PUBLISHED_SKILL, 'Use when driving the software.'));
  const build = runAipm(['build'], repo);
  expect(build.code, build.stdout + build.stderr).toBe(0);
}, 180_000);

afterAll(() => {
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
});

function writeContributorSkill(extraFrontmatter = ''): void {
  const abs = path.join(repo, ...CONTRIBUTOR_SKILL_REL.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    skillMd(CONTRIBUTOR_SKILL, 'Use when cutting a release of this repo.', extraFrontmatter),
  );
}

describe('published-surface boundary (#118)', () => {
  it('baseline: a repo with only the published plugin validates clean', () => {
    const result = runAipm(['validate'], repo);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(listOfferedSkills(repo)).toEqual([PUBLISHED_SKILL]);
  });

  describe('with an unmarked contributor skill', () => {
    beforeAll(() => {
      writeContributorSkill();
    });

    it('the skills CLI offers the contributor skill to users (the leak)', () => {
      expect(listOfferedSkills(repo)).toEqual([CONTRIBUTOR_SKILL, PUBLISHED_SKILL].sort());
    });

    it('aipm validate fails, naming the file and the fix', () => {
      const result = runAipm(['validate'], repo);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('unpublished-skill-installable');
      // Named exactly once: the finding is repo-level, so there is no `[plugin]` scope prefix
      // repeating the path the message already starts with.
      expect(result.stdout.split(CONTRIBUTOR_SKILL_REL)).toHaveLength(3);
      expect(result.stdout).toContain('internal: true');
    });

    it("aipm build still succeeds: the boundary is validate's concern, not build's", () => {
      const result = runAipm(['build'], repo);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('Built 1 plugin(s)');
      expect(result.stdout).not.toContain('unpublished-skill-installable');
    });

    it('aipm lint reports the same rule as an error', () => {
      const result = runAipm(['lint', '--format', 'json'], repo);
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        diagnostics: { ruleId: string; severity: string; file: string }[];
      };
      expect(parsed.diagnostics).toContainEqual(
        expect.objectContaining({
          ruleId: 'correctness/unpublished-skill-installable',
          severity: 'error',
          file: CONTRIBUTOR_SKILL_REL,
        }),
      );
    });
  });

  describe('once the contributor skill is marked metadata.internal: true', () => {
    beforeAll(() => {
      writeContributorSkill('metadata:\n  internal: true\n');
    });

    it('aipm validate passes', () => {
      const result = runAipm(['validate'], repo);
      expect(result.code, result.stdout + result.stderr).toBe(0);
    });

    it('the skills CLI offers only the published skill', () => {
      expect(listOfferedSkills(repo)).toEqual([PUBLISHED_SKILL]);
    });

    it('no generated registry for any target mentions the contributor skill', () => {
      const rebuild = runAipm(['build'], repo);
      expect(rebuild.code, rebuild.stdout + rebuild.stderr).toBe(0);

      const present = REGISTRY_REL_PATHS.filter((rel) => fs.existsSync(path.join(repo, rel)));
      // At least the Claude registry exists for a scaffolded plugin; guards against a vacuous pass.
      expect(present).toContain('.claude-plugin/marketplace.json');
      for (const rel of present) {
        const text = fs.readFileSync(path.join(repo, rel), 'utf-8');
        expect(text, rel).not.toContain(CONTRIBUTOR_SKILL);
        const registry = JSON.parse(text) as { plugins: { name: string }[] };
        expect(
          registry.plugins.map((p) => p.name),
          rel,
        ).toEqual([PUBLISHED_SKILL]);
      }
    });
  });
});
