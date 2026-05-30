/**
 * Tests for the Cursor scaffold templates.
 *
 * Asserts the produced manifest parses against `cursorPluginManifestSchema`, carries
 * `schemaVersion: "0.1.0"` (§12.2), and reflects the given name/description.
 *
 * @see docs/specs/architecture.md §6.4, §12.2, §12.5
 */

import { describe, expect, it } from 'vitest';

import { cursorPluginManifestSchema } from './schemas.js';
import { scaffoldCursorFiles } from './scaffold.js';

function fileAt(files: { path: string; content: string }[], relPath: string): string {
  const match = files.find((f) => f.path === relPath);
  expect(match, `expected scaffold to produce ${relPath}`).toBeDefined();
  return match?.content ?? '';
}

describe('scaffoldCursorFiles', () => {
  it('produces the minimum-required manifest at .cursor-plugin/plugin.json', () => {
    const files = scaffoldCursorFiles('my-plugin', { description: 'Does a thing' });
    expect(files.map((f) => f.path)).toStrictEqual(['.cursor-plugin/plugin.json']);
  });

  it('produces a manifest that parses against the Cursor schema', () => {
    const content = fileAt(
      scaffoldCursorFiles('my-plugin', { description: 'Does a thing' }),
      '.cursor-plugin/plugin.json',
    );
    expect(cursorPluginManifestSchema.safeParse(JSON.parse(content)).success).toBe(true);
  });

  it('sets schemaVersion to 0.1.0, name, and description', () => {
    const content = fileAt(
      scaffoldCursorFiles('my-plugin', { description: 'Does a thing' }),
      '.cursor-plugin/plugin.json',
    );
    const manifest = JSON.parse(content) as Record<string, unknown>;
    expect(manifest.schemaVersion).toBe('0.1.0');
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.description).toBe('Does a thing');
  });

  it('omits description in placeholder mode but stays schema-valid', () => {
    const content = fileAt(
      scaffoldCursorFiles('my-plugin', { placeholder: true }),
      '.cursor-plugin/plugin.json',
    );
    const manifest = JSON.parse(content) as Record<string, unknown>;
    expect(manifest.description).toBeUndefined();
    expect(cursorPluginManifestSchema.safeParse(manifest).success).toBe(true);
  });
});
