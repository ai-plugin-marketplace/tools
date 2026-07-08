/**
 * Tests for the Open Plugins scaffold templates.
 *
 * Asserts the produced manifest parses against `openPluginsManifestSchema`, carries
 * `schemaVersion: "0.1.0"` (§12.2), lives at `.plugin/plugin.json`, and reflects the given
 * name/description.
 *
 * @see https://open-plugins.com/plugin-builders/specification.md
 * @see docs/specs/architecture.md §6.4, §12.2, §12.5
 */

import { describe, expect, it } from 'vitest';

import { openPluginsManifestSchema } from './schemas.js';
import { scaffoldOpenPluginsFiles } from './scaffold.js';

function fileAt(files: { path: string; content: string }[], relPath: string): string {
  const match = files.find((f) => f.path === relPath);
  expect(match, `expected scaffold to produce ${relPath}`).toBeDefined();
  return match?.content ?? '';
}

describe('scaffoldOpenPluginsFiles', () => {
  it('produces the minimum-required manifest at .plugin/plugin.json', () => {
    const files = scaffoldOpenPluginsFiles('my-plugin', { description: 'Does a thing' });
    expect(files.map((f) => f.path)).toStrictEqual(['.plugin/plugin.json']);
  });

  it('produces a manifest that parses against the Open Plugins schema', () => {
    const content = fileAt(
      scaffoldOpenPluginsFiles('my-plugin', { description: 'Does a thing' }),
      '.plugin/plugin.json',
    );
    expect(openPluginsManifestSchema.safeParse(JSON.parse(content)).success).toBe(true);
  });

  it('sets schemaVersion to 0.1.0, name, and description', () => {
    const content = fileAt(
      scaffoldOpenPluginsFiles('my-plugin', { description: 'Does a thing' }),
      '.plugin/plugin.json',
    );
    const manifest = JSON.parse(content) as Record<string, unknown>;
    expect(manifest.schemaVersion).toBe('0.1.0');
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.description).toBe('Does a thing');
  });

  it('ends the manifest with a trailing newline (2-space JSON)', () => {
    const content = fileAt(scaffoldOpenPluginsFiles('my-plugin'), '.plugin/plugin.json');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('omits description in placeholder mode but stays schema-valid', () => {
    const content = fileAt(
      scaffoldOpenPluginsFiles('my-plugin', { placeholder: true }),
      '.plugin/plugin.json',
    );
    const manifest = JSON.parse(content) as Record<string, unknown>;
    expect(manifest.description).toBeUndefined();
    expect(openPluginsManifestSchema.safeParse(manifest).success).toBe(true);
  });
});
