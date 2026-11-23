/**
 * Subprocess UAT for skill audience: one `aipm build` of a repo whose plugin has a user-only and
 * an agent-only skill, driven through the built CLI (`dist/bin.js`) as a user would run it.
 *
 * It checks what the user sees and gets: the exit code, the per-target outcome report and the
 * warning on stdout, the files each target installs, and where the registries point.
 *
 * Expectations come from the unified content model: §5.1 (Claude Code restricts both audiences
 * natively; Codex restricts a user-only skill through `agents/openai.yaml` and cannot hide an
 * agent-only one, which is therefore left out with a warning naming the skill and the host), §5.3
 * (the `audience` key is removed from every host's output) and §4 (an omitted feature is reported
 * as `unavailable` with the fidelity list `[omitted]`).
 *
 * @see https://github.com/ai-plugin-marketplace/normalizer/blob/main/docs/specs/unified-model.md
 * @see https://code.claude.com/docs/en/skills.md#control-who-invokes-a-skill
 * @see https://learn.chatgpt.com/docs/build-skills.md#optional-metadata
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(CLI_DIR, 'dist', 'bin.js');

const MANIFEST = `${JSON.stringify({ name: 'demo', version: '0.0.1', description: 'A demo plugin.' }, null, 2)}\n`;

function skillMd(name: string, audience: 'user' | 'agent'): string {
  return `---\nname: ${name}\ndescription: Use when testing the ${name} skill.\naudience: ${audience}\n---\n\n# ${name}\n`;
}

/** The authored repo: a workspace and one plugin for Claude Code and Codex. */
const REPO_FILES: Record<string, string> = {
  'aipm.workspace.ts':
    "import { defineWorkspace } from '@ai-plugin-marketplace/core';\n\nexport default defineWorkspace({ marketplace: { name: 'audience-uat-marketplace' } });\n",
  'plugins/demo/aipm.config.ts':
    "import { defineConfig } from '@ai-plugin-marketplace/core';\n\nexport default defineConfig({ version: '0.0.1', targets: ['claude', 'codex'] });\n",
  'plugins/demo/.claude-plugin/plugin.json': MANIFEST,
  'plugins/demo/.codex-plugin/plugin.json': MANIFEST,
  'plugins/demo/skills/for-user/SKILL.md': skillMd('for-user', 'user'),
  'plugins/demo/skills/for-agent/SKILL.md': skillMd('for-agent', 'agent'),
};

let repo: string;
let build: { code: number; stdout: string; stderr: string };

function read(...rel: string[]): string {
  return fs.readFileSync(path.join(repo, ...rel), 'utf-8');
}

beforeAll(() => {
  // Real build, so the subprocess runs the same compiled artifact a real install would.
  execFileSync('pnpm', ['exec', 'tsc', '--build'], { cwd: CLI_DIR, stdio: 'inherit' });

  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-audience-uat-')));
  for (const [rel, content] of Object.entries(REPO_FILES)) {
    const abs = path.join(repo, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const result = spawnSync(process.execPath, [BIN_PATH, 'build'], { cwd: repo, encoding: 'utf-8' });
  build = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}, 180_000);

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('aipm build of a plugin whose skills state an audience', () => {
  it('succeeds: an omitted skill is a warning, not a failure', () => {
    expect(build.code, build.stdout + build.stderr).toBe(0);
    expect(build.stdout).toContain('Built 1 plugin(s)');
  });

  it('prints where each target’s form is and how each skill is delivered there', () => {
    const lines = build.stdout.split('\n');
    const at = (line: string): number => lines.indexOf(line);

    const claude = at('[demo] claude: dist/claude/demo');
    const codex = at('[demo] codex: dist/codex/demo');
    expect(claude).toBeGreaterThanOrEqual(0);
    expect(codex).toBeGreaterThan(claude);

    // Claude Code has its own control for both audiences.
    const claudeLines = lines.slice(claude + 1, codex);
    expect(claudeLines).toContain("    skills.audience 'for-user': native");
    expect(claudeLines).toContain("    skills.audience 'for-agent': native");

    // Codex restricts the user-only skill natively and cannot hide the agent-only one.
    const codexLines = lines.slice(codex + 1, codex + 3);
    expect(codexLines).toContain("    skills.audience 'for-user': native");
    expect(codexLines).toContain("    skills.audience 'for-agent': unavailable [omitted]");
  });

  it('prints the warning for the omitted skill, naming the skill and the host', () => {
    const warning = build.stdout
      .split('\n')
      .find((line) => line.startsWith('[demo] skill-audience-omitted (soft): '));
    expect(warning).toBeDefined();
    expect(warning).toContain('for-agent');
    expect(warning).toContain('Codex');
    expect(build.stdout).not.toContain('(hard)');
  });

  it('writes the form each target installs', () => {
    const claudeUser = read('dist', 'claude', 'demo', 'skills', 'for-user', 'SKILL.md');
    expect(claudeUser).toContain('disable-model-invocation: true');
    expect(claudeUser).not.toContain('audience:');
    const claudeAgent = read('dist', 'claude', 'demo', 'skills', 'for-agent', 'SKILL.md');
    expect(claudeAgent).toContain('user-invocable: false');
    expect(claudeAgent).not.toContain('audience:');

    expect(fs.readdirSync(path.join(repo, 'dist', 'codex', 'demo', 'skills'))).toStrictEqual([
      'for-user',
    ]);
    expect(read('dist', 'codex', 'demo', 'skills', 'for-user', 'SKILL.md')).not.toContain(
      'audience:',
    );
    expect(read('dist', 'codex', 'demo', 'skills', 'for-user', 'agents', 'openai.yaml')).toContain(
      'allow_implicit_invocation: false',
    );

    // The authored skill is untouched.
    expect(read('plugins', 'demo', 'skills', 'for-agent', 'SKILL.md')).toBe(
      skillMd('for-agent', 'agent'),
    );
  });

  it('points each registry at its target’s form', () => {
    const claude = JSON.parse(read('.claude-plugin', 'marketplace.json')) as {
      plugins: { name: string; source: string }[];
    };
    expect(claude.plugins).toStrictEqual([{ name: 'demo', source: './dist/claude/demo' }]);

    const codex = JSON.parse(read('.agents', 'plugins', 'marketplace.json')) as {
      plugins: { name: string; source: { source: string; path: string } }[];
    };
    expect(codex.plugins.map((p) => p.source)).toStrictEqual([
      { source: 'local', path: './dist/codex/demo' },
    ]);
  });

  it('leaves a repo that `aipm validate` accepts as fresh', () => {
    const result = spawnSync(process.execPath, [BIN_PATH, 'validate'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain('freshness');
  });
});
