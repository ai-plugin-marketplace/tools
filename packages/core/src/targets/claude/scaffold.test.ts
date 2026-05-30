/**
 * Tests for the Claude Code scaffold templates.
 *
 * Asserts the produced manifest parses against `claudePluginManifestSchema`, carries
 * `schemaVersion: "0.1.0"` (§12.2), and reflects the given name/description. Negative cases cover
 * placeholder mode (description omitted) and that the path is the minimum-required artifact.
 *
 * @see docs/specs/architecture.md §6.4, §12.2, §12.5
 */

import { describe, expect, it } from 'vitest';

import { claudePluginManifestSchema } from './schemas.js';
import { scaffoldClaudeFiles } from './scaffold.js';

/** Find the single file at `relPath` in a scaffold result; fails the test if absent. */
function fileAt(files: { path: string; content: string }[], relPath: string): string {
  const match = files.find((f) => f.path === relPath);
  expect(match, `expected scaffold to produce ${relPath}`).toBeDefined();
  return match?.content ?? '';
}

describe('scaffoldClaudeFiles', () => {
  it('produces the minimum-required manifest at .claude-plugin/plugin.json', () => {
    const files = scaffoldClaudeFiles('my-plugin', { description: 'Does a thing' });
    expect(files.map((f) => f.path)).toStrictEqual(['.claude-plugin/plugin.json']);
  });

  it('produces a manifest that parses against the Claude schema', () => {
    const content = fileAt(
      scaffoldClaudeFiles('my-plugin', { description: 'Does a thing' }),
      '.claude-plugin/plugin.json',
    );
    const parsed = claudePluginManifestSchema.safeParse(JSON.parse(content));
    expect(parsed.success).toBe(true);
  });

  it('sets schemaVersion to 0.1.0, name, and description', () => {
    const content = fileAt(
      scaffoldClaudeFiles('my-plugin', { description: 'Does a thing' }),
      '.claude-plugin/plugin.json',
    );
    const manifest = JSON.parse(content) as Record<string, unknown>;
    expect(manifest.schemaVersion).toBe('0.1.0');
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.description).toBe('Does a thing');
  });

  it('defaults the description when none is supplied', () => {
    const content = fileAt(scaffoldClaudeFiles('my-plugin'), '.claude-plugin/plugin.json');
    const manifest = JSON.parse(content) as Record<string, unknown>;
    expect(manifest.description).toBe('A plugin for my-plugin');
  });

  it('omits description in placeholder mode but stays schema-valid (negative: no empty description)', () => {
    const content = fileAt(
      scaffoldClaudeFiles('my-plugin', { placeholder: true }),
      '.claude-plugin/plugin.json',
    );
    const manifest = JSON.parse(content) as Record<string, unknown>;
    // An empty-string description would violate `.min(1)`; the scaffold omits the field instead.
    expect(manifest.description).toBeUndefined();
    expect(claudePluginManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('is deterministic across invocations', () => {
    const a = scaffoldClaudeFiles('my-plugin', { description: 'Does a thing' });
    const b = scaffoldClaudeFiles('my-plugin', { description: 'Does a thing' });
    expect(a).toStrictEqual(b);
  });
});
