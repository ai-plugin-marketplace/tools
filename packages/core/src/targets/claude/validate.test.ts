/**
 * Tests for the Claude Code per-target validator.
 *
 * Test fixtures are built programmatically in OS temp directories so that the
 * tests are self-contained and reproducible. The parity test copies the real
 * `skill-evaluator` plugin from the template repo to verify zero findings.
 *
 * @see docs/specs/architecture.md §10 (validation contract)
 * @see docs/specs/architecture.md §8.1 (Finding, FindingCode types)
 * @see docs/specs/architecture.md §10.1.5 (Claude hooks live in the auto-loaded `hooks/hooks.json`)
 * @see docs/specs/hooks-json-autoload-collision.md — why the manifest carries no `hooks` field
 * @see https://code.claude.com/docs/en/plugins-reference — plugin manifest `hooks` field
 *   (`string|array|object`, e.g. `"./my-extra-hooks.json"`) and the Hooks component's
 *   auto-loaded location: "`hooks/hooks.json` in plugin root, or inline in plugin.json".
 * @see https://code.claude.com/docs/en/hooks — Claude hooks file format.
 *   Error contract observed from Claude Code on a duplicate reference:
 *   "Duplicate hooks file detected … The standard hooks/hooks.json is loaded automatically,
 *   so manifest.hooks should only reference additional hook files."
 * @see https://github.com/ai-plugin-marketplace/template — `plugins/skill-evaluator/` (parity fixture)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Finding } from '../../pipeline/types.js';
import { sidecarContent } from '../../pipeline/sentinel.js';
import { stripGeneratedArtifacts } from '../../test-support/synth-plugin.js';
import { TEMPLATE_REPO, TEMPLATE_REPO_AVAILABLE } from '../../test-support/template-repo.js';
import { validateClaudePlugin } from './validate.js';

// ---------------------------------------------------------------------------
// Template repo path (for the parity test)
// ---------------------------------------------------------------------------

const SKILL_EVALUATOR_DIR = path.join(TEMPLATE_REPO, 'plugins', 'skill-evaluator');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal valid `.claude-plugin/plugin.json` manifest for a plugin named `test-plugin`.
 * No optional refs, so no filesystem entries need to exist beyond the manifest file itself.
 */
const MINIMAL_MANIFEST = JSON.stringify({
  name: 'test-plugin',
  version: '0.1.0',
  description: 'A minimal test plugin',
});

/**
 * Valid agent frontmatter content (matches `claudeAgentFrontmatterSchema`).
 */
const VALID_AGENT_MD = `---
name: my-agent
description: Does something useful
tools:
  - Read
  - Write
---

# My Agent

Body text here.
`;

/**
 * Valid hooks JSON (matches `claudeHooksFileSchema`).
 */
const VALID_HOOKS_JSON = JSON.stringify({
  hooks: {
    PostToolUse: [
      {
        matcher: 'Write',
        description: 'Log writes',
        hooks: [{ type: 'command', command: 'echo wrote' }],
      },
    ],
  },
});

/**
 * Generated hooks JSON for the skill-evaluator parity test.
 * Derived from `plugins/skill-evaluator/hooks/claude.yaml` per the transform spec.
 */
const SKILL_EVALUATOR_HOOKS_JSON =
  JSON.stringify(
    {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write',
            description: 'Log evaluation report writes to a structured log file',
            hooks: [
              {
                type: 'command',
                command: `if echo "$TOOL_INPUT" | grep -q 'evaluation-report'; then echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Evaluation report written" >> .evaluation-log.jsonl; fi`,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

/** Create a temporary directory and return its path. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-validate-test-'));
}

/** Write a file, creating parent directories as needed. */
function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

/** Create a directory (and any missing parents). */
function makeDir(dir: string, relPath: string): void {
  fs.mkdirSync(path.join(dir, relPath), { recursive: true });
}

/** Copy a directory tree recursively. */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('validateClaudePlugin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Positive: no findings for a well-formed plugin
  // -------------------------------------------------------------------------

  describe('positive cases', () => {
    it('returns zero findings for a minimal plugin with no optional refs', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings for a plugin with all valid file refs', () => {
      writeFile(
        tmpDir,
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'full-plugin',
          skills: ['./skills/my-skill'],
          agents: ['./agents/my-agent.md'],
          commands: ['./commands/run.md'],
        }),
      );
      makeDir(tmpDir, 'skills/my-skill');
      writeFile(tmpDir, 'agents/my-agent.md', VALID_AGENT_MD);
      writeFile(tmpDir, 'commands/run.md', '# Command');
      writeFile(tmpDir, 'hooks/hooks.json', VALID_HOOKS_JSON);

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings when agents/ directory does not exist', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      // No agents/ directory — not an error

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings when hooks/hooks.json does not exist', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      // hooks/hooks.json is optional — absence must not produce a finding

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings when there are valid agents with all required frontmatter fields', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'agents/assistant.md', VALID_AGENT_MD);

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Negative: manifest file-ref failures
  // -------------------------------------------------------------------------

  describe('manifest file refs', () => {
    it('emits schema-invalid when agents path references a missing .md file', () => {
      writeFile(
        tmpDir,
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'test-plugin',
          agents: ['./agents/missing.md'],
        }),
      );

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.plugin).toBe(path.basename(tmpDir));
      expect(finding.message).toContain('./agents/missing.md');
    });

    it('emits schema-invalid when skills path points to a file instead of a directory', () => {
      writeFile(
        tmpDir,
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'test-plugin',
          skills: ['./skills/not-a-dir'],
        }),
      );
      // Create a regular file where a directory is expected
      writeFile(tmpDir, 'skills/not-a-dir', 'not a directory');

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.message).toContain('must be a directory');
      expect(finding.message).toContain('./skills/not-a-dir');
    });

    it('emits schema-invalid when hooks path references a non-existent file', () => {
      writeFile(
        tmpDir,
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'test-plugin',
          hooks: './hooks/claude.json',
        }),
      );
      // hooks/claude.json intentionally absent

      const findings = validateClaudePlugin(tmpDir);

      // One finding for the missing path, one for the manifest hooks field itself.
      expect(findings).toHaveLength(2);
      const missing = findings.filter((f) => f.message.includes('non-existent path'));
      expect(missing).toHaveLength(1);
      expect(missing[0]?.severity).toBe('hard');
      expect(missing[0]?.code).toBe('schema-invalid');
      expect(missing[0]?.message).toContain('./hooks/claude.json');
    });

    it('emits schema-invalid for each missing ref (one per missing path)', () => {
      writeFile(
        tmpDir,
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'test-plugin',
          agents: ['./agents/a.md', './agents/b.md'],
        }),
      );

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(2);
      for (const finding of findings) {
        expect(finding.code).toBe('schema-invalid');
        expect(finding.severity).toBe('hard');
      }
    });

    it('rejects an inline hooks object: no path to check, but the manifest must not name hooks', () => {
      writeFile(
        tmpDir,
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'test-plugin',
          hooks: { PreToolUse: [] },
        }),
      );

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('has a hooks field');
    });
  });

  // -------------------------------------------------------------------------
  // Negative: manifest schema shape (required-field enforcement)
  // -------------------------------------------------------------------------
  // Regression coverage for #92: a structurally-valid JSON object that omits a
  // schema-required field (e.g. `name`) must be caught here — this is distinct from the
  // "manifest file refs" cases above (valid shape, bad ref) and from malformed JSON (caught
  // earlier in validateManifestFileRefs). Before the fix, a schema parse failure other than
  // invalid JSON silently produced zero findings.

  describe('manifest schema shape', () => {
    it('emits a hard schema-invalid finding when plugin.json is missing the required "name" field', () => {
      writeFile(
        tmpDir,
        '.claude-plugin/plugin.json',
        JSON.stringify({
          version: '0.1.0',
          description: 'A plugin manifest missing its required name field',
        }),
      );

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.plugin).toBe(path.basename(tmpDir));
      expect(finding.message).toContain('.claude-plugin/plugin.json');
      expect(finding.message).toContain('name');
    });
  });

  // -------------------------------------------------------------------------
  // Negative: agent frontmatter failures
  // -------------------------------------------------------------------------

  describe('agent frontmatter', () => {
    it('emits schema-invalid when agent .md has no frontmatter block', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'agents/no-frontmatter.md', '# No Frontmatter\n\nJust a body.\n');

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.message).toContain('no-frontmatter.md');
      expect(finding.message).toContain('no frontmatter');
    });

    it('emits schema-invalid when agent frontmatter is missing description', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'agents/no-desc.md', `---\nname: my-agent\n---\n\n# Body\n`);

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.message).toContain('no-desc.md');
    });

    it('emits schema-invalid when agent frontmatter is missing name', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'agents/no-name.md', `---\ndescription: Does stuff\n---\n\n# Body\n`);

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.message).toContain('no-name.md');
    });

    it('emits one finding per invalid agent file', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'agents/good.md', VALID_AGENT_MD);
      writeFile(tmpDir, 'agents/bad.md', '# No Frontmatter\n');

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('bad.md');
    });

    it('ignores non-.md files in agents/ directory', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'agents/readme.txt', 'not an agent');

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('ignores subdirectories inside agents/ (one level deep only)', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      // Subdir with a bad .md file should be ignored in v0.1.0
      writeFile(tmpDir, 'agents/subdir/nested.md', '# No Frontmatter\n');

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Negative: hooks file failures
  // -------------------------------------------------------------------------

  describe('hooks file', () => {
    it('emits schema-invalid when hooks/hooks.json uses an unknown event name', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      // The schema check applies to toolkit-generated files, marked by the sidecar.
      writeFile(
        tmpDir,
        'hooks/hooks.json.generated',
        sidecarContent('hooks/claude.yaml', '0.11.0'),
      );
      writeFile(tmpDir, 'hooks/claude.yaml', 'hooks: {}\n');
      writeFile(
        tmpDir,
        'hooks/hooks.json',
        JSON.stringify({
          hooks: {
            BadEvent: [{ hooks: [{ type: 'command', command: 'echo bad' }] }],
          },
        }),
      );

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.message).toContain('hooks/hooks.json');
    });

    it('emits schema-invalid when hooks/hooks.json is not valid JSON', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'hooks/hooks.json', 'not json {{{');

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.message).toContain('hooks/hooks.json');
      expect(finding.message).toContain('not valid JSON');
    });

    it('emits schema-invalid when hooks/hooks.json has invalid hook entry shape', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      // The schema check applies to toolkit-generated files, marked by the sidecar.
      writeFile(
        tmpDir,
        'hooks/hooks.json.generated',
        sidecarContent('hooks/claude.yaml', '0.11.0'),
      );
      writeFile(tmpDir, 'hooks/claude.yaml', 'hooks: {}\n');
      writeFile(
        tmpDir,
        'hooks/hooks.json',
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  // Missing required `type: "command"` field
                  { command: 'echo missing-type' },
                ],
              },
            ],
          },
        }),
      );

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
    });

    it('does not emit a finding when hooks/hooks.json is absent', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      // No hooks/hooks.json — this is valid

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    // The Claude desktop app drops hooks from its remote plugin sync when hooks/hooks.json has
    // any top-level key besides $schema, description and hooks, so a `_generated` marker (the old
    // json-field sentinel) must be rejected rather than tolerated.
    it('rejects a _generated key on hooks/hooks.json (remote sync drops the file)', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(
        tmpDir,
        'hooks/hooks.json',
        JSON.stringify({
          _generated: { by: '@ai-plugin-marketplace/cli', source: 'hooks/claude.yaml' },
          hooks: {
            PostToolUse: [
              { matcher: 'Write', hooks: [{ type: 'command', command: 'echo wrote' }] },
            ],
          },
        }),
      );

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('hard');
      expect(findings[0]?.message).toContain('_generated');
    });

    it('accepts $schema and description alongside hooks', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(
        tmpDir,
        'hooks/hooks.json',
        JSON.stringify({
          $schema: 'https://json.schemastore.org/claude-code-settings.json',
          description: 'Example hooks',
          hooks: {
            PostToolUse: [
              { matcher: 'Write', hooks: [{ type: 'command', command: 'echo wrote' }] },
            ],
          },
        }),
      );

      expect(validateClaudePlugin(tmpDir)).toHaveLength(0);
    });

    it('accepts a hand-written hooks/hooks.json with events the YAML compiler does not model', () => {
      // Claude Code accepts SessionStart (and more) natively; only generated files are held to the
      // compiler's source schema.
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(
        tmpDir,
        'hooks/hooks.json',
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
        }),
      );

      expect(validateClaudePlugin(tmpDir)).toHaveLength(0);
    });

    it('emits a HARD finding for a generated hooks/hooks.json whose hooks/claude.yaml is gone', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'hooks/hooks.json', VALID_HOOKS_JSON);
      writeFile(
        tmpDir,
        'hooks/hooks.json.generated',
        sidecarContent('hooks/claude.yaml', '0.11.0'),
      );

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('hard');
      expect(findings[0]?.message).toContain('no longer exists');
    });

    it.each([
      ['null', 'null'],
      ['an array', '[]'],
      ['a non-object hooks field', '{"hooks":42}'],
      ['an event that is not an array', '{"hooks":{"Stop":{}}}'],
    ])('emits a HARD finding when a hand-written hooks/hooks.json is %s', (_label, body) => {
      // Regression: an unmarked hooks/hooks.json skipped every shape check, so a file Claude Code
      // cannot read passed validation.
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'hooks/hooks.json', body);

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('hard');
    });

    it('does not treat a sidecar another tool wrote as a generated hooks/hooks.json', () => {
      // Regression: any hooks/hooks.json.generated file made a hand-written hooks.json look
      // generated, so validation told the author to delete their hooks.
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'hooks/hooks.json', VALID_HOOKS_JSON);
      writeFile(tmpDir, 'hooks/hooks.json.generated', '# generated by unrelated tooling\n');

      expect(validateClaudePlugin(tmpDir)).toHaveLength(0);
    });

    it('emits a HARD finding for a leftover hooks/claude.json', () => {
      writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
      writeFile(tmpDir, 'hooks/claude.json', VALID_HOOKS_JSON);

      const findings = validateClaudePlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('hard');
      expect(findings[0]?.message).toContain('hooks/claude.json is no longer generated');
    });
  });

  // -------------------------------------------------------------------------
  // Finding structure invariants
  // -------------------------------------------------------------------------

  describe('finding structure', () => {
    it('every finding has severity: "hard", code: "schema-invalid", and a plugin field', () => {
      writeFile(
        tmpDir,
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'test-plugin',
          agents: ['./agents/missing.md'],
        }),
      );

      const findings = validateClaudePlugin(tmpDir);

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.severity).toBe('hard');
        expect(finding.code).toBe('schema-invalid');
        expect(finding.plugin).toBe(path.basename(tmpDir));
        expect(typeof finding.message).toBe('string');
        expect(finding.message.length).toBeGreaterThan(0);
      }
    });

    it('plugin field equals path.basename(pluginDir)', () => {
      const namedDir = path.join(tmpDir, 'my-special-plugin');
      fs.mkdirSync(namedDir);
      writeFile(
        namedDir,
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'test-plugin',
          agents: ['./agents/missing.md'],
        }),
      );

      const findings = validateClaudePlugin(namedDir);

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.plugin).toBe('my-special-plugin');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Parity: zero findings on the real skill-evaluator plugin
  // -------------------------------------------------------------------------

  describe.skipIf(!TEMPLATE_REPO_AVAILABLE)('parity with skill-evaluator', () => {
    it('returns zero findings when run against a copy of the skill-evaluator plugin with generated artifacts', () => {
      // Copy the real plugin into a temp directory, drop whatever generated artifacts the
      // template happens to commit (they track the template's own toolkit version), and add the
      // Claude hooks file this toolkit's build writes from `hooks/claude.yaml`.
      const pluginCopy = path.join(tmpDir, 'skill-evaluator');
      copyDirRecursive(SKILL_EVALUATOR_DIR, pluginCopy);
      stripGeneratedArtifacts(pluginCopy);
      writeFile(pluginCopy, 'hooks/hooks.json', SKILL_EVALUATOR_HOOKS_JSON);

      const findings = validateClaudePlugin(pluginCopy);

      expect(findings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Open Plugins conformance advisories (spec §7 / OP-D10) — always SOFT
// ---------------------------------------------------------------------------

describe('validateClaudePlugin — open-plugins-conformance advisories', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const advisories = (findings: Finding[]): Finding[] =>
    findings.filter((f) => f.code === 'open-plugins-conformance');

  it('emits a SOFT advisory for a Claude-legal but Open-Plugins-illegal name (a--b)', () => {
    // `a--b` passes the Claude name regex (^[a-z][a-z0-9-]*$) but Open Plugins forbids "--".
    writeFile(
      tmpDir,
      '.claude-plugin/plugin.json',
      JSON.stringify({ name: 'a--b', version: '0.1.0' }),
    );
    const findings = validateClaudePlugin(tmpDir);
    const adv = advisories(findings);
    expect(adv).toHaveLength(1);
    expect(adv[0]?.severity).toBe('soft');
    // The advisory never contributes a hard finding.
    expect(findings.every((f) => f.severity === 'soft')).toBe(true);
  });

  it('emits a SOFT metadata-dir advisory for a stray file in .claude-plugin/', () => {
    writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
    writeFile(tmpDir, '.claude-plugin/notes.md', 'stray');
    const adv = advisories(validateClaudePlugin(tmpDir));
    expect(adv).toHaveLength(1);
    expect(adv[0]?.severity).toBe('soft');
    expect(adv[0]?.message).toContain('notes.md');
  });

  it('emits NO advisory for a native-valid, Open-Plugins-conformant plugin', () => {
    writeFile(tmpDir, '.claude-plugin/plugin.json', MINIMAL_MANIFEST);
    expect(advisories(validateClaudePlugin(tmpDir))).toEqual([]);
  });

  it('does NOT double-report: a Claude-INVALID name draws no soft drift advisory', () => {
    // `Bad Name` fails the Claude schema; the drift advisory is reserved for native-VALID names, so
    // it must stay silent here (no piling a soft advisory onto an already-broken manifest).
    writeFile(tmpDir, '.claude-plugin/plugin.json', JSON.stringify({ name: 'Bad Name' }));
    expect(advisories(validateClaudePlugin(tmpDir))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Path-traversal hardening (spec §7 item 1 / traversal audit) — mcpServers
// ---------------------------------------------------------------------------

describe('validateClaudePlugin — mcpServers path traversal', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a HARD schema-invalid when mcpServers contains a ".." segment', () => {
    // `./a/../b.json` passes the "./…json" regex but is a path-traversal escape — reject it hard.
    writeFile(
      tmpDir,
      '.claude-plugin/plugin.json',
      JSON.stringify({ name: 'test-plugin', mcpServers: './a/../b.json' }),
    );
    const findings = validateClaudePlugin(tmpDir);
    const hard = findings.filter((f) => f.code === 'schema-invalid');
    expect(hard).toHaveLength(1);
    expect(hard[0]?.severity).toBe('hard');
    expect(hard[0]?.message).toMatch(/mcpServers.*"\.\."/);
  });

  it('accepts a traversal-free mcpServers config path', () => {
    writeFile(
      tmpDir,
      '.claude-plugin/plugin.json',
      JSON.stringify({ name: 'test-plugin', mcpServers: './.mcp.json' }),
    );
    expect(validateClaudePlugin(tmpDir).filter((f) => f.code === 'schema-invalid')).toEqual([]);
  });

  // Regression (PR #30 review): a substring `includes('..')` check falsely rejected filenames that
  // merely contain consecutive dots. Only a whole `..` SEGMENT is traversal.
  it('accepts an mcpServers filename containing consecutive dots (./my..config.json)', () => {
    writeFile(
      tmpDir,
      '.claude-plugin/plugin.json',
      JSON.stringify({ name: 'test-plugin', mcpServers: './my..config.json' }),
    );
    expect(validateClaudePlugin(tmpDir).filter((f) => f.code === 'schema-invalid')).toEqual([]);
  });

  it('rejects a backslash-separated ".." segment in mcpServers (./a\\..\\b.json)', () => {
    writeFile(
      tmpDir,
      '.claude-plugin/plugin.json',
      JSON.stringify({ name: 'test-plugin', mcpServers: './a\\..\\b.json' }),
    );
    const hard = validateClaudePlugin(tmpDir).filter((f) => f.code === 'schema-invalid');
    expect(hard).toHaveLength(1);
    expect(hard[0]?.severity).toBe('hard');
  });
});

// ---------------------------------------------------------------------------
// Manifest hooks field (architecture.md §10.1.5)
// ---------------------------------------------------------------------------
// Claude Code auto-loads `<pluginDir>/hooks/hooks.json` and hard-errors when the manifest also
// names it ("Duplicate hooks file detected"). The Claude desktop app refuses to sync any plugin
// whose manifest has a `hooks` field to remote (SSH) hosts ("refusing plugin that relocates hooks
// via manifest"). So every form of the field is a HARD finding.

describe('validateClaudePlugin — manifest hooks field', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const manifestHookFindings = (findings: Finding[]): Finding[] =>
    findings.filter((f) => f.message.includes('hooks field'));

  it.each([
    ['./hooks/hooks.json', './hooks/hooks.json'],
    ['./hooks/claude.json (the retired toolkit path)', './hooks/claude.json'],
    ['a path written without "./"', 'hooks/./hooks.json'],
    ['an array of paths', ['./hooks/extra.json', './hooks/hooks.json']],
    ['an inline hooks object', { Stop: [] }],
  ])('emits a HARD schema-invalid for %s', (_label, hooks) => {
    writeFile(tmpDir, '.claude-plugin/plugin.json', JSON.stringify({ name: 'test-plugin', hooks }));
    writeFile(tmpDir, 'hooks/hooks.json', VALID_HOOKS_JSON);
    writeFile(tmpDir, 'hooks/extra.json', VALID_HOOKS_JSON);

    const found = manifestHookFindings(validateClaudePlugin(tmpDir));

    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('hard');
    expect(found[0]?.code).toBe('schema-invalid');
    expect(found[0]?.message).toContain('remote (SSH) hosts');
  });

  it('emits a HARD finding for hooks under experimental', () => {
    writeFile(
      tmpDir,
      '.claude-plugin/plugin.json',
      JSON.stringify({ name: 'test-plugin', experimental: { hooks: './hooks/extra.json' } }),
    );

    const found = manifestHookFindings(validateClaudePlugin(tmpDir));

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('experimental.hooks field');
  });

  it('emits NO finding when hooks/hooks.json exists and the manifest omits hooks', () => {
    writeFile(tmpDir, '.claude-plugin/plugin.json', JSON.stringify({ name: 'test-plugin' }));
    writeFile(tmpDir, 'hooks/hooks.json', VALID_HOOKS_JSON);

    expect(validateClaudePlugin(tmpDir)).toHaveLength(0);
  });
});
