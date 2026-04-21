/**
 * Tests for Gemini CLI target Zod schemas.
 *
 * Validates `geminiExtensionManifestSchema` and `geminiAgentFrontmatterSchema` against
 * realistic inputs derived from the template repository's real plugin examples.
 *
 * @see /plugins/skill-evaluator/gemini-extension.json  (real manifest example)
 * @see /plugins/skill-evaluator/GEMINI.md             (real agent context example)
 * @see docs/specs/architecture.md §9.4, §12.2         (schemaVersion reserved field)
 */

import { describe, expect, it } from 'vitest';
import {
  GEMINI_TOOL_NAMES,
  geminiAgentFrontmatterSchema,
  geminiExtensionManifestSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// geminiExtensionManifestSchema
// ---------------------------------------------------------------------------

describe('geminiExtensionManifestSchema', () => {
  it('accepts a fully-populated realistic manifest', () => {
    const result = geminiExtensionManifestSchema.safeParse({
      name: 'skill-evaluator',
      version: '0.0.1',
      description:
        'Evaluate AI skills across model tiers with blind testing and refinement recommendations',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('skill-evaluator');
      expect(result.data.version).toBe('0.0.1');
    }
  });

  it('accepts a minimal manifest with only the required name field', () => {
    const result = geminiExtensionManifestSchema.safeParse({ name: 'my-plugin' });
    expect(result.success).toBe(true);
  });

  it('accepts schemaVersion: "0.1.0" per §9.4 reserved field', () => {
    const result = geminiExtensionManifestSchema.safeParse({
      name: 'my-plugin',
      schemaVersion: '0.1.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe('0.1.0');
    }
  });

  it('tolerates unknown top-level fields (loose schema)', () => {
    const result = geminiExtensionManifestSchema.safeParse({
      name: 'my-plugin',
      someGeminiSpecificField: 'value',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a manifest missing the required name field', () => {
    const result = geminiExtensionManifestSchema.safeParse({
      version: '1.0.0',
      description: 'No name here',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a manifest where name is not a string', () => {
    const result = geminiExtensionManifestSchema.safeParse({ name: 42 });
    expect(result.success).toBe(false);
  });

  it('rejects a manifest where version is not a string', () => {
    const result = geminiExtensionManifestSchema.safeParse({ name: 'my-plugin', version: 1 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// geminiAgentFrontmatterSchema
// ---------------------------------------------------------------------------

describe('geminiAgentFrontmatterSchema', () => {
  it('accepts a fully-populated frontmatter with tools', () => {
    const result = geminiAgentFrontmatterSchema.safeParse({
      name: 'experimenter',
      description: 'Evaluates AI skills and produces a refinement report',
      tools: ['read_file', 'run_shell_command', 'activate_skill'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('experimenter');
      expect(result.data.tools).toHaveLength(3);
    }
  });

  it('accepts frontmatter with no tools field (optional)', () => {
    const result = geminiAgentFrontmatterSchema.safeParse({
      name: 'my-agent',
      description: 'A simple agent',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toBeUndefined();
    }
  });

  it('accepts schemaVersion: "0.1.0" per §9.4 reserved field', () => {
    const result = geminiAgentFrontmatterSchema.safeParse({
      name: 'my-agent',
      description: 'An agent with a schema version',
      schemaVersion: '0.1.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe('0.1.0');
    }
  });

  it('tolerates unknown frontmatter fields (loose schema)', () => {
    const result = geminiAgentFrontmatterSchema.safeParse({
      name: 'my-agent',
      description: 'An agent',
      someExtraField: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a tool name that is not in GEMINI_TOOL_NAMES (no enum enforcement at schema layer)', () => {
    // Stage 3's transform layer — not this schema — is responsible for tool-name validation.
    const result = geminiAgentFrontmatterSchema.safeParse({
      name: 'my-agent',
      description: 'An agent',
      tools: ['some_future_tool'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects frontmatter missing the required name field', () => {
    const result = geminiAgentFrontmatterSchema.safeParse({
      description: 'No name provided',
    });
    expect(result.success).toBe(false);
  });

  it('rejects frontmatter missing the required description field', () => {
    const result = geminiAgentFrontmatterSchema.safeParse({
      name: 'my-agent',
    });
    expect(result.success).toBe(false);
  });

  it('rejects frontmatter where tools contains a non-string entry', () => {
    const result = geminiAgentFrontmatterSchema.safeParse({
      name: 'my-agent',
      description: 'An agent',
      tools: ['read_file', 42],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GEMINI_TOOL_NAMES regression guard
// ---------------------------------------------------------------------------

describe('GEMINI_TOOL_NAMES', () => {
  it('contains exactly the seven canonical Gemini CLI tool names', () => {
    // Derived from the CLAUDE_TO_GEMINI_TOOLS mapping in build-standalone.ts.
    // This test is a regression guard: if the tool-name table changes, this
    // test will fail and force a deliberate review.
    expect(GEMINI_TOOL_NAMES).toHaveLength(7);
    expect(GEMINI_TOOL_NAMES).toContain('read_file');
    expect(GEMINI_TOOL_NAMES).toContain('replace');
    expect(GEMINI_TOOL_NAMES).toContain('search_file_content');
    expect(GEMINI_TOOL_NAMES).toContain('glob');
    expect(GEMINI_TOOL_NAMES).toContain('run_shell_command');
    expect(GEMINI_TOOL_NAMES).toContain('write_file');
    expect(GEMINI_TOOL_NAMES).toContain('activate_skill');
  });
});
