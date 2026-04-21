/**
 * Tests for the Kiro per-target validator.
 *
 * Fixtures are built programmatically in OS temp directories so that the tests
 * are self-contained and reproducible. The parity test copies the real
 * `skill-evaluator` plugin from the template repo to verify zero findings.
 *
 * @see docs/specs/architecture.md §10 (validation contract)
 * @see docs/specs/architecture.md §8.1 (Finding, FindingCode types)
 * @see /Users/mnorth/Development/ai-plugin-marketplace-template/plugins/skill-evaluator/
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Finding } from '../../pipeline/types.js';
import { validateKiroPlugin } from './validate.js';

// ---------------------------------------------------------------------------
// Template repo path (for the parity test)
// ---------------------------------------------------------------------------

const TEMPLATE_REPO = path.resolve(
  import.meta.dirname,
  '../../../../../../ai-plugin-marketplace-template',
);
const SKILL_EVALUATOR_DIR = path.join(TEMPLATE_REPO, 'plugins', 'skill-evaluator');

// ---------------------------------------------------------------------------
// Fixture content constants
// ---------------------------------------------------------------------------

/**
 * Valid POWER.md frontmatter for a plugin named `test-plugin`.
 * Uses all required fields: name, description, version.
 */
const VALID_POWER_MD = (name: string): string => `---
name: ${name}
description: A test plugin for validation
version: 0.1.0
---

# ${name}

Body text here.
`;

/**
 * Valid mcp.json with an empty mcpServers record.
 * `kiroMcpConfigSchema` requires `mcpServers` to be a record; empty is valid.
 */
const VALID_MCP_JSON = JSON.stringify({ mcpServers: {} });

/**
 * A valid agent .md whose tools are all in CLAUDE_TO_KIRO_TOOLS.
 * Tools used: Read, Write, Bash — all have Kiro equivalents.
 */
const VALID_AGENT_MD = `---
name: my-agent
description: Does something useful
tools:
  - Read
  - Write
  - Bash
---

# My Agent

Body text here.
`;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory and return its path. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-kiro-validate-test-'));
}

/** Write a file, creating parent directories as needed. */
function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
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

describe('validateKiroPlugin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Positive: no findings when files are absent or well-formed
  // -------------------------------------------------------------------------

  describe('positive cases', () => {
    it('returns zero findings when POWER.md is not present', () => {
      // Envelope-adherence owns the "file missing" check; validate only what exists.
      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings for a valid POWER.md whose name matches the directory', () => {
      const pluginDir = path.join(tmpDir, 'my-plugin');
      fs.mkdirSync(pluginDir);
      writeFile(pluginDir, 'POWER.md', VALID_POWER_MD('my-plugin'));

      const findings = validateKiroPlugin(pluginDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings for a valid mcp.json', () => {
      writeFile(tmpDir, 'POWER.md', VALID_POWER_MD(path.basename(tmpDir)));
      writeFile(tmpDir, 'mcp.json', VALID_MCP_JSON);

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings when mcp.json is absent', () => {
      writeFile(tmpDir, 'POWER.md', VALID_POWER_MD(path.basename(tmpDir)));
      // No mcp.json — absence is not an error at this layer

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings for an agent whose tools are all mappable', () => {
      const pluginDir = path.join(tmpDir, 'my-plugin');
      fs.mkdirSync(pluginDir);
      writeFile(pluginDir, 'POWER.md', VALID_POWER_MD('my-plugin'));
      writeFile(pluginDir, 'agents/good-agent.md', VALID_AGENT_MD);

      const findings = validateKiroPlugin(pluginDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings when agents/ directory does not exist', () => {
      writeFile(tmpDir, 'POWER.md', VALID_POWER_MD(path.basename(tmpDir)));
      // No agents/ directory

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('ignores non-.md files in agents/ directory', () => {
      writeFile(tmpDir, 'POWER.md', VALID_POWER_MD(path.basename(tmpDir)));
      writeFile(tmpDir, 'agents/readme.txt', 'not an agent');

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('ignores subdirectories inside agents/ (one level deep only)', () => {
      writeFile(tmpDir, 'POWER.md', VALID_POWER_MD(path.basename(tmpDir)));
      writeFile(tmpDir, 'agents/subdir/nested.md', '# No Frontmatter\n');

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Negative: POWER.md frontmatter schema failures
  // -------------------------------------------------------------------------

  describe('POWER.md frontmatter validation', () => {
    it('emits a hard schema-invalid finding when POWER.md has no frontmatter block', () => {
      writeFile(tmpDir, 'POWER.md', '# No Frontmatter\n\nJust body text.\n');

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.plugin).toBe(path.basename(tmpDir));
      expect(finding.message).toContain('no frontmatter block');
    });

    it('emits a hard schema-invalid finding when POWER.md frontmatter is missing version', () => {
      const pluginDir = path.join(tmpDir, 'my-plugin');
      fs.mkdirSync(pluginDir);
      writeFile(
        pluginDir,
        'POWER.md',
        `---\nname: my-plugin\ndescription: A plugin\n---\n\n# Body\n`,
      );

      const findings = validateKiroPlugin(pluginDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.plugin).toBe('my-plugin');
      expect(finding.message).toContain('schema');
    });

    it('emits a hard schema-invalid finding when POWER.md frontmatter is missing description', () => {
      const pluginDir = path.join(tmpDir, 'my-plugin');
      fs.mkdirSync(pluginDir);
      writeFile(pluginDir, 'POWER.md', `---\nname: my-plugin\nversion: 0.1.0\n---\n\n# Body\n`);

      const findings = validateKiroPlugin(pluginDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
    });

    it('emits a hard schema-invalid finding when POWER.md frontmatter is missing name', () => {
      const pluginDir = path.join(tmpDir, 'my-plugin');
      fs.mkdirSync(pluginDir);
      writeFile(
        pluginDir,
        'POWER.md',
        `---\ndescription: A plugin\nversion: 0.1.0\n---\n\n# Body\n`,
      );

      const findings = validateKiroPlugin(pluginDir);

      // Missing name triggers schema-invalid (schema check) before name-consistency
      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
    });
  });

  // -------------------------------------------------------------------------
  // Negative: POWER.md name-consistency failures
  // -------------------------------------------------------------------------

  describe('POWER.md name-consistency', () => {
    it('emits a hard name-consistency finding when frontmatter name does not match the plugin directory', () => {
      const pluginDir = path.join(tmpDir, 'foo');
      fs.mkdirSync(pluginDir);
      writeFile(pluginDir, 'POWER.md', VALID_POWER_MD('other-name'));

      const findings = validateKiroPlugin(pluginDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('name-consistency');
      expect(finding.plugin).toBe('foo');
      expect(finding.message).toContain("'other-name'");
      expect(finding.message).toContain("'foo'");
    });

    it('does not emit name-consistency when frontmatter name matches the plugin directory', () => {
      const pluginDir = path.join(tmpDir, 'exact-match');
      fs.mkdirSync(pluginDir);
      writeFile(pluginDir, 'POWER.md', VALID_POWER_MD('exact-match'));

      const findings = validateKiroPlugin(pluginDir);

      expect(findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Negative: mcp.json schema failures
  // -------------------------------------------------------------------------

  describe('mcp.json validation', () => {
    it('emits a hard schema-invalid finding when mcp.json is not valid JSON', () => {
      writeFile(tmpDir, 'mcp.json', 'not json {{{');

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.plugin).toBe(path.basename(tmpDir));
      expect(finding.message).toContain('mcp.json');
      expect(finding.message).toContain('not valid JSON');
    });

    it('emits a hard schema-invalid finding when mcpServers is not an object', () => {
      writeFile(tmpDir, 'mcp.json', JSON.stringify({ mcpServers: 'not-an-object' }));

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.message).toContain('mcp.json');
    });

    it('emits a hard schema-invalid finding when mcp.json is missing mcpServers entirely', () => {
      writeFile(tmpDir, 'mcp.json', JSON.stringify({ someOtherKey: true }));

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
    });

    it('emits a hard schema-invalid finding when a server entry has an unknown key (strict schema)', () => {
      writeFile(
        tmpDir,
        'mcp.json',
        JSON.stringify({
          mcpServers: {
            'my-server': { command: 'node', unknownField: true },
          },
        }),
      );

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('hard');
      expect(finding.code).toBe('schema-invalid');
    });

    it('returns zero findings for a valid mcp.json with populated server entries', () => {
      writeFile(
        tmpDir,
        'mcp.json',
        JSON.stringify({
          mcpServers: {
            'my-server': {
              command: 'node',
              args: ['server.js'],
              env: { API_KEY: 'test' },
            },
          },
        }),
      );

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Negative (soft): agent tool-name translation warnings
  // -------------------------------------------------------------------------

  describe('agent tool-name translation warnings', () => {
    it('emits a soft schema-invalid finding for each unmapped Claude tool in an agent', () => {
      writeFile(
        tmpDir,
        'agents/reviewer.md',
        `---
name: reviewer
description: Reviews code
tools:
  - Read
  - UnknownTool
---

# Reviewer
`,
      );

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      const [finding] = findings as [Finding];
      expect(finding.severity).toBe('soft');
      expect(finding.code).toBe('schema-invalid');
      expect(finding.plugin).toBe(path.basename(tmpDir));
      expect(finding.message).toContain("'reviewer'");
      expect(finding.message).toContain("'UnknownTool'");
      expect(finding.message).toContain('dropped');
    });

    it('emits one soft finding per unmapped tool (multiple unknowns)', () => {
      writeFile(
        tmpDir,
        'agents/multi.md',
        `---
name: multi
description: Multi-tool agent
tools:
  - Read
  - FakeTool1
  - FakeTool2
---

# Multi
`,
      );

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(2);
      for (const finding of findings) {
        expect(finding.severity).toBe('soft');
        expect(finding.code).toBe('schema-invalid');
      }
      const messages = findings.map((f) => f.message);
      expect(messages.some((m) => m.includes('FakeTool1'))).toBe(true);
      expect(messages.some((m) => m.includes('FakeTool2'))).toBe(true);
    });

    it('emits soft findings across multiple agent files', () => {
      writeFile(
        tmpDir,
        'agents/agent-a.md',
        `---
name: agent-a
description: Agent A
tools:
  - UnknownA
---

# Agent A
`,
      );
      writeFile(
        tmpDir,
        'agents/agent-b.md',
        `---
name: agent-b
description: Agent B
tools:
  - UnknownB
---

# Agent B
`,
      );

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(2);
      for (const finding of findings) {
        expect(finding.severity).toBe('soft');
        expect(finding.code).toBe('schema-invalid');
      }
    });

    it('returns zero findings for an agent with only mappable tools', () => {
      // All of: Read, Write, Edit, Glob, Grep, Bash, Agent have Kiro equivalents
      writeFile(
        tmpDir,
        'agents/all-known.md',
        `---
name: all-known
description: Uses only known tools
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
---

# All Known
`,
      );

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings for an agent with no tools field', () => {
      writeFile(
        tmpDir,
        'agents/no-tools.md',
        `---
name: no-tools
description: Agent without tools list
---

# No Tools
`,
      );

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings for an agent with no frontmatter (Claude validator owns that check)', () => {
      writeFile(tmpDir, 'agents/no-fm.md', '# No Frontmatter\n\nBody only.\n');

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('soft findings do not affect validation result semantics (severity stays soft)', () => {
      writeFile(
        tmpDir,
        'agents/soft-only.md',
        `---
name: soft-only
description: Emits only soft findings
tools:
  - GhostTool
---

# Soft Only
`,
      );

      const findings = validateKiroPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('soft');
      // Soft findings should NOT be hard — they must not flip ValidationResult.passed
    });
  });

  // -------------------------------------------------------------------------
  // Finding structure invariants
  // -------------------------------------------------------------------------

  describe('finding structure', () => {
    it('every finding has a non-empty message and a plugin field equal to path.basename(pluginDir)', () => {
      const pluginDir = path.join(tmpDir, 'structure-check');
      fs.mkdirSync(pluginDir);
      // Trigger both a schema-invalid (missing version) and no name-consistency
      writeFile(pluginDir, 'POWER.md', `---\nname: structure-check\ndescription: x\n---\n# Body\n`);
      writeFile(pluginDir, 'mcp.json', JSON.stringify({ mcpServers: 'bad' }));

      const findings = validateKiroPlugin(pluginDir);

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.plugin).toBe('structure-check');
        expect(typeof finding.message).toBe('string');
        expect(finding.message.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Parity: zero findings on the real skill-evaluator plugin
  // -------------------------------------------------------------------------

  describe('parity with skill-evaluator', () => {
    it('returns zero findings when run against a copy of the skill-evaluator plugin', () => {
      // Copy the real skill-evaluator into a temp directory so we can use its
      // real Kiro files (POWER.md, mcp.json, agents/) without modifying the template repo.
      const pluginCopy = path.join(tmpDir, 'skill-evaluator');
      copyDirRecursive(SKILL_EVALUATOR_DIR, pluginCopy);

      const findings = validateKiroPlugin(pluginCopy);

      expect(findings).toHaveLength(0);
    });
  });
});
