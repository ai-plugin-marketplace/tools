/**
 * Tests for Gemini CLI per-target validator.
 *
 * @see docs/specs/architecture.md §10 (validation contract)
 * @see docs/specs/architecture.md §8.1 (Finding types)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMPLATE_REPO } from '../../test-support/template-repo.js';
import { validateGeminiPlugin } from './validate.js';

// ---------------------------------------------------------------------------
// Paths to template repo (test-only references; never imported as code)
// ---------------------------------------------------------------------------

const SKILL_EVALUATOR_DIR = path.join(TEMPLATE_REPO, 'plugins', 'skill-evaluator');

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-validate-test-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePluginDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAgentMd(pluginDir: string, filename: string, tools: string[] | null): void {
  const agentsDir = path.join(pluginDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const toolsBlock =
    tools !== null && tools.length > 0
      ? `tools:\n${tools.map((t) => `  - ${t}`).join('\n')}\n`
      : '';

  const content = `---\nname: ${path.basename(filename, '.md')}\ndescription: Test agent\n${toolsBlock}---\n\n# Body\n`;
  fs.writeFileSync(path.join(agentsDir, filename), content, 'utf-8');
}

function writeAgentMdNoTools(pluginDir: string, filename: string): void {
  const agentsDir = path.join(pluginDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const content = `---\nname: ${path.basename(filename, '.md')}\ndescription: Agent without tools key\n---\n\n# Body\n`;
  fs.writeFileSync(path.join(agentsDir, filename), content, 'utf-8');
}

function writeGeminiExtensionJson(pluginDir: string, data: unknown): void {
  fs.writeFileSync(
    path.join(pluginDir, 'gemini-extension.json'),
    JSON.stringify(data, null, 2),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateGeminiPlugin', () => {
  describe('skill-evaluator parity', () => {
    it('produces zero findings for the real skill-evaluator plugin', () => {
      const findings = validateGeminiPlugin(SKILL_EVALUATOR_DIR);
      expect(findings).toEqual([]);
    });
  });

  describe('gemini-extension.json absence', () => {
    it('produces no findings when gemini-extension.json is missing (cross-target handles envelope)', () => {
      const pluginDir = makePluginDir('no-manifest');
      writeAgentMd(pluginDir, 'helper.md', ['Read', 'Write']);
      const findings = validateGeminiPlugin(pluginDir);
      expect(findings).toEqual([]);
    });
  });

  describe('agent tool-name translation warnings', () => {
    it('emits one soft schema-invalid finding per unmapped tool', () => {
      const pluginDir = makePluginDir('unmapped-tools');
      writeAgentMd(pluginDir, 'reviewer.md', ['Read', 'UnknownFakeTool']);

      const findings = validateGeminiPlugin(pluginDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings;
      expect(finding?.severity).toBe('soft');
      expect(finding?.code).toBe('schema-invalid');
      expect(finding?.plugin).toBe('unmapped-tools');
      expect(finding?.message).toContain("agent 'reviewer'");
      expect(finding?.message).toContain("'UnknownFakeTool'");
      expect(finding?.message).toContain('no Gemini equivalent');
    });

    it('does not emit a finding for tools that have a Gemini mapping', () => {
      const pluginDir = makePluginDir('all-mapped');
      writeAgentMd(pluginDir, 'worker.md', [
        'Read',
        'Write',
        'Bash',
        'Glob',
        'Grep',
        'Edit',
        'Agent',
      ]);

      const findings = validateGeminiPlugin(pluginDir);
      expect(findings).toEqual([]);
    });

    it('does not emit a finding when agent has no tools key', () => {
      const pluginDir = makePluginDir('no-tools-key');
      writeAgentMdNoTools(pluginDir, 'minimal.md');

      const findings = validateGeminiPlugin(pluginDir);
      expect(findings).toEqual([]);
    });

    it('emits multiple soft findings when multiple agents have multiple unmapped tools', () => {
      const pluginDir = makePluginDir('multi-agents');
      writeAgentMd(pluginDir, 'agent-a.md', ['Read', 'FakeTool1', 'FakeTool2']);
      writeAgentMd(pluginDir, 'agent-b.md', ['Write', 'AnotherFake']);

      const findings = validateGeminiPlugin(pluginDir);

      // 2 from agent-a + 1 from agent-b = 3 soft findings
      expect(findings).toHaveLength(3);
      expect(findings.every((f) => f.severity === 'soft')).toBe(true);
      expect(findings.every((f) => f.code === 'schema-invalid')).toBe(true);

      const messages = findings.map((f) => f.message);
      expect(messages.some((m) => m.includes("'FakeTool1'"))).toBe(true);
      expect(messages.some((m) => m.includes("'FakeTool2'"))).toBe(true);
      expect(messages.some((m) => m.includes("'AnotherFake'"))).toBe(true);
    });
  });

  describe('gemini-extension.json schema validation', () => {
    it('produces no findings for a valid manifest', () => {
      const pluginDir = makePluginDir('valid-manifest');
      writeGeminiExtensionJson(pluginDir, {
        name: 'valid-manifest',
        version: '1.0.0',
        description: 'A valid plugin',
      });

      const findings = validateGeminiPlugin(pluginDir);
      expect(findings).toEqual([]);
    });

    it('emits one hard schema-invalid finding when a required field has the wrong type', () => {
      const pluginDir = makePluginDir('bad-manifest');
      // `name` must be a string; passing a number triggers a hard finding
      writeGeminiExtensionJson(pluginDir, { name: 42, version: '1.0.0' });

      const findings = validateGeminiPlugin(pluginDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings;
      expect(finding?.severity).toBe('hard');
      expect(finding?.code).toBe('schema-invalid');
      expect(finding?.plugin).toBe('bad-manifest');
      expect(finding?.message).toContain('gemini-extension.json failed schema validation');
    });

    it('emits one hard schema-invalid finding when the required name field is absent', () => {
      const pluginDir = makePluginDir('missing-name');
      writeGeminiExtensionJson(pluginDir, { version: '1.0.0' });

      const findings = validateGeminiPlugin(pluginDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('hard');
      expect(findings[0]?.code).toBe('schema-invalid');
    });
  });

  describe('soft findings do not indicate failure', () => {
    it('all findings from unmapped-tool warnings are severity soft (non-blocking)', () => {
      const pluginDir = makePluginDir('soft-check');
      writeAgentMd(pluginDir, 'drafter.md', ['Read', 'NonExistentTool']);

      const findings = validateGeminiPlugin(pluginDir);

      // All soft — none should be 'hard', confirming ValidationResult.passed stays true
      expect(findings.every((f) => f.severity === 'soft')).toBe(true);
      expect(findings.some((f) => f.severity === 'hard')).toBe(false);
    });
  });
});
