/**
 * Positive/negative tests for the four new §3.2 correctness rules:
 * `broken-file-ref`, `unknown-hook-event`, `invalid-matcher`, `duplicate-component-name`.
 *
 * @see docs/specs/lint-engine.md §3.2
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRuleContext } from '../context.js';
import type { RuleContext } from '../types.js';
import { brokenFileRefRule } from './broken-file-ref.js';
import { duplicateComponentNameRule } from './duplicate-component-name.js';
import { invalidMatcherRule } from './invalid-matcher.js';
import { unknownHookEventRule } from './unknown-hook-event.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-lint-new-rules-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(pluginDir: string, rel: string, content: string | object): void {
  const full = path.join(pluginDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    'utf-8',
  );
}

function makeCtx(pluginDir: string): RuleContext {
  return createRuleContext({
    pluginDir,
    repoRoot: path.dirname(pluginDir),
    distDir: path.join(path.dirname(pluginDir), 'dist'),
    envelope: ['claude'],
    workspace: undefined,
    ci: false,
  });
}

describe('correctness/broken-file-ref', () => {
  it('is silent when every manifest reference resolves', async () => {
    const pluginDir = path.join(tmpDir, 'plugin-a');
    write(pluginDir, '.claude-plugin/plugin.json', { name: 'plugin-a', agents: './agents/foo.md' });
    write(pluginDir, 'agents/foo.md', '---\nname: foo\ndescription: does things\n---\n');
    const diagnostics = await brokenFileRefRule.check(makeCtx(pluginDir));
    expect(diagnostics).toEqual([]);
  });

  it('flags a manifest reference to a file that does not exist', async () => {
    const pluginDir = path.join(tmpDir, 'plugin-b');
    write(pluginDir, '.claude-plugin/plugin.json', {
      name: 'plugin-b',
      agents: './agents/missing.md',
    });
    const diagnostics = await brokenFileRefRule.check(makeCtx(pluginDir));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      ruleId: 'correctness/broken-file-ref',
      severity: 'error',
      file: '.claude-plugin/plugin.json',
    });
    expect(diagnostics[0]?.message).toContain('./agents/missing.md');
  });
});

describe('correctness/unknown-hook-event', () => {
  it('is silent when hooks/claude.yaml has no hooks/claude.yaml file', async () => {
    const pluginDir = path.join(tmpDir, 'plugin-c');
    fs.mkdirSync(pluginDir, { recursive: true });
    expect(await unknownHookEventRule.check(makeCtx(pluginDir))).toEqual([]);
  });

  it('is silent when every event name is recognized', async () => {
    const pluginDir = path.join(tmpDir, 'plugin-d');
    write(
      pluginDir,
      'hooks/claude.yaml',
      'hooks:\n  PreToolUse:\n    - matcher: "Bash"\n      hooks:\n        - type: command\n          command: echo hi\n',
    );
    expect(await unknownHookEventRule.check(makeCtx(pluginDir))).toEqual([]);
  });

  it('flags an event name outside the recognized set', async () => {
    const pluginDir = path.join(tmpDir, 'plugin-e');
    write(
      pluginDir,
      'hooks/claude.yaml',
      'hooks:\n  SessionStart:\n    - hooks:\n        - type: command\n          command: echo hi\n',
    );
    const diagnostics = await unknownHookEventRule.check(makeCtx(pluginDir));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("unrecognized hook event 'SessionStart'");
    expect(diagnostics[0]?.range).toBeDefined();
  });
});

describe('correctness/invalid-matcher', () => {
  it('is silent when every matcher is a valid regex', async () => {
    const pluginDir = path.join(tmpDir, 'plugin-f');
    write(
      pluginDir,
      'hooks/claude.yaml',
      'hooks:\n  PreToolUse:\n    - matcher: "Bash|Read"\n      hooks:\n        - type: command\n          command: echo hi\n',
    );
    expect(await invalidMatcherRule.check(makeCtx(pluginDir))).toEqual([]);
  });

  it('flags an invalid regex matcher', async () => {
    const pluginDir = path.join(tmpDir, 'plugin-g');
    write(
      pluginDir,
      'hooks/claude.yaml',
      'hooks:\n  PreToolUse:\n    - matcher: "Bash("\n      hooks:\n        - type: command\n          command: echo hi\n',
    );
    const diagnostics = await invalidMatcherRule.check(makeCtx(pluginDir));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("matcher 'Bash(' is not a valid regular expression");
  });
});

describe('correctness/duplicate-component-name', () => {
  it('is silent when every skill/agent/command name is unique', async () => {
    const pluginDir = path.join(tmpDir, 'plugin-h');
    write(pluginDir, 'skills/a/SKILL.md', '---\nname: skill-a\ndescription: d\n---\n');
    write(pluginDir, 'skills/b/SKILL.md', '---\nname: skill-b\ndescription: d\n---\n');
    expect(await duplicateComponentNameRule.check(makeCtx(pluginDir))).toEqual([]);
  });

  it('flags two skills declaring the same frontmatter name', async () => {
    const pluginDir = path.join(tmpDir, 'plugin-i');
    write(pluginDir, 'skills/a/SKILL.md', '---\nname: shared-name\ndescription: d\n---\n');
    write(pluginDir, 'skills/b/SKILL.md', '---\nname: shared-name\ndescription: d\n---\n');
    const diagnostics = await duplicateComponentNameRule.check(makeCtx(pluginDir));
    expect(diagnostics).toHaveLength(2);
    for (const d of diagnostics) {
      expect(d.message).toContain("skill name 'shared-name' collides with");
    }
  });

  it('does not flag a skill and an agent sharing a name (distinct namespaces)', async () => {
    const pluginDir = path.join(tmpDir, 'plugin-j');
    write(pluginDir, 'skills/a/SKILL.md', '---\nname: shared\ndescription: d\n---\n');
    write(pluginDir, 'agents/shared.md', '---\nname: shared\ndescription: d\n---\n');
    expect(await duplicateComponentNameRule.check(makeCtx(pluginDir))).toEqual([]);
  });
});
