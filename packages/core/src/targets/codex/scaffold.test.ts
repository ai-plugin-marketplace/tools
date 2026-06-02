/**
 * Tests for the Codex scaffold templates.
 *
 * Asserts the produced manifest parses against `codexPluginManifestSchema`, carries
 * `schemaVersion: "0.1.0"` (§12.2), and reflects the given name/description.
 *
 * @see https://developers.openai.com/codex/plugins/build
 * @see docs/specs/architecture.md §6.4, §12.2, §12.5
 */

import { describe, expect, it } from 'vitest';

import { codexPluginManifestSchema } from './schemas.js';
import { scaffoldCodexFiles } from './scaffold.js';

function fileAt(files: { path: string; content: string }[], relPath: string): string {
  const match = files.find((f) => f.path === relPath);
  expect(match, `expected scaffold to produce ${relPath}`).toBeDefined();
  return match?.content ?? '';
}

describe('scaffoldCodexFiles', () => {
  it('produces the minimum-required manifest at .codex-plugin/plugin.json', () => {
    const files = scaffoldCodexFiles('my-plugin', { description: 'Does a thing' });
    expect(files.map((f) => f.path)).toStrictEqual(['.codex-plugin/plugin.json']);
  });

  it('produces a manifest that parses against the Codex schema', () => {
    const content = fileAt(
      scaffoldCodexFiles('my-plugin', { description: 'Does a thing' }),
      '.codex-plugin/plugin.json',
    );
    expect(codexPluginManifestSchema.safeParse(JSON.parse(content)).success).toBe(true);
  });

  it('sets schemaVersion to 0.1.0, name, and description', () => {
    const content = fileAt(
      scaffoldCodexFiles('my-plugin', { description: 'Does a thing' }),
      '.codex-plugin/plugin.json',
    );
    const manifest = JSON.parse(content) as Record<string, unknown>;
    expect(manifest.schemaVersion).toBe('0.1.0');
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.description).toBe('Does a thing');
  });

  it('omits description in placeholder mode but stays schema-valid', () => {
    const content = fileAt(
      scaffoldCodexFiles('my-plugin', { placeholder: true }),
      '.codex-plugin/plugin.json',
    );
    const manifest = JSON.parse(content) as Record<string, unknown>;
    expect(manifest.description).toBeUndefined();
    expect(codexPluginManifestSchema.safeParse(manifest).success).toBe(true);
  });
});
