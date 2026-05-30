/**
 * Tests for the Gemini CLI scaffold templates.
 *
 * Asserts the produced `gemini-extension.json` parses against `geminiExtensionManifestSchema`,
 * carries `schemaVersion: "0.1.0"` (§12.2), and that the referenced `GEMINI.md` is emitted.
 *
 * @see docs/specs/architecture.md §6.4, §12.2, §12.5
 */

import { describe, expect, it } from 'vitest';

import { geminiExtensionManifestSchema } from './schemas.js';
import { scaffoldGeminiFiles } from './scaffold.js';

function fileAt(files: { path: string; content: string }[], relPath: string): string {
  const match = files.find((f) => f.path === relPath);
  expect(match, `expected scaffold to produce ${relPath}`).toBeDefined();
  return match?.content ?? '';
}

describe('scaffoldGeminiFiles', () => {
  it('produces gemini-extension.json and the referenced GEMINI.md', () => {
    const paths = scaffoldGeminiFiles('my-plugin', { description: 'Does a thing' })
      .map((f) => f.path)
      .sort();
    expect(paths).toStrictEqual(['GEMINI.md', 'gemini-extension.json']);
  });

  it('produces a manifest that parses against the Gemini schema', () => {
    const content = fileAt(
      scaffoldGeminiFiles('my-plugin', { description: 'Does a thing' }),
      'gemini-extension.json',
    );
    expect(geminiExtensionManifestSchema.safeParse(JSON.parse(content)).success).toBe(true);
  });

  it('sets schemaVersion to 0.1.0, name, description, and contextFileName', () => {
    const content = fileAt(
      scaffoldGeminiFiles('my-plugin', { description: 'Does a thing' }),
      'gemini-extension.json',
    );
    const manifest = JSON.parse(content) as Record<string, unknown>;
    expect(manifest.schemaVersion).toBe('0.1.0');
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.description).toBe('Does a thing');
    expect(manifest.contextFileName).toBe('GEMINI.md');
  });

  it('embeds the plugin name and description in GEMINI.md', () => {
    const content = fileAt(
      scaffoldGeminiFiles('my-plugin', { description: 'Does a thing' }),
      'GEMINI.md',
    );
    expect(content).toContain('# my-plugin');
    expect(content).toContain('Does a thing');
  });
});
