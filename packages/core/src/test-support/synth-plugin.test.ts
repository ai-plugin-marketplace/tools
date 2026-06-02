/**
 * Tests for `stripGeneratedArtifacts` — the fixture step that restores a copied plugin tree to
 * author-authored source state by removing toolkit-GENERATED files (§4.3).
 *
 * Runs in CI: it builds a synthetic tree with the real sentinel carriers and needs no template
 * checkout. Regression guard for the latent fixture bug — the template ships committed
 * `hooks/claude.json` / `hooks/hooks.json` (json-field sentinel) that were being copied verbatim,
 * so "no mechanical output" assertions observed the fixture rather than the build output.
 *
 * `synthPluginRepo` itself is exercised by the developer-machine-only parity suites
 * (`pipeline/build.test.ts`), which depend on a real template checkout.
 *
 * @see docs/specs/architecture.md §4.3 (author-authored vs toolkit-generated — sentinel carriers)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyInlineSentinel,
  applyJsonSentinel,
  sidecarContent,
  sidecarPath,
} from '../pipeline/sentinel.js';
import { stripGeneratedArtifacts } from './synth-plugin.js';

describe('stripGeneratedArtifacts', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-strip-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  /** Write `content` to `rel` under the temp dir, creating parents. */
  function write(rel: string, content: string): string {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
    return abs;
  }

  it('removes a JSON file carrying a `_generated` field sentinel', () => {
    write('hooks/claude.json', applyJsonSentinel({ hooks: {} }, 'hooks/claude.yaml'));

    const removed = stripGeneratedArtifacts(dir);

    expect(removed).toEqual([path.join('hooks', 'claude.json')]);
    expect(fs.existsSync(path.join(dir, 'hooks', 'claude.json'))).toBe(false);
  });

  it('removes a plain-text file carrying an inline-comment sentinel', () => {
    write('GENERATED.md', applyInlineSentinel('# body\n', 'source.md'));

    const removed = stripGeneratedArtifacts(dir);

    expect(removed).toEqual(['GENERATED.md']);
    expect(fs.existsSync(path.join(dir, 'GENERATED.md'))).toBe(false);
  });

  it('removes a sidecar-marked artifact AND its `.generated` marker (both are generated, §4.3)', () => {
    // In the sidecar carrier the strict-schema artifact carries no in-band sentinel; the companion
    // `.generated` file marks it. Both must go so the fixture is pure author-source state.
    const artifactRel = 'gemini-extension.json';
    const sidecarRel = path.relative(dir, sidecarPath(path.join(dir, artifactRel)));
    write(artifactRel, JSON.stringify({ name: 'skill-evaluator' }, null, 2) + '\n');
    write(sidecarRel, sidecarContent(artifactRel));

    const removed = stripGeneratedArtifacts(dir);

    expect(removed).toEqual([artifactRel, sidecarRel].sort());
    expect(fs.existsSync(path.join(dir, artifactRel))).toBe(false);
    expect(fs.existsSync(path.join(dir, sidecarRel))).toBe(false);
  });

  it('removes a dangling `.generated` marker even when its companion artifact is absent', () => {
    // Defensive: a sidecar with no companion must not throw, and only the marker is reported.
    const sidecarRel = path.relative(dir, sidecarPath(path.join(dir, 'gemini-extension.json')));
    write(sidecarRel, sidecarContent('gemini-extension.json'));

    const removed = stripGeneratedArtifacts(dir);

    expect(removed).toEqual([sidecarRel]);
    expect(fs.existsSync(path.join(dir, sidecarRel))).toBe(false);
  });

  it('keeps author-authored files, including JSON without a `_generated` field', () => {
    // Negative cases: a YAML source, a README, and a hand-authored JSON config with no sentinel.
    write('hooks/claude.yaml', 'PreToolUse: []\n');
    write('README.md', '# skill-evaluator\n');
    write('.mcp.json', JSON.stringify({ mcpServers: { foo: {} } }, null, 2) + '\n');

    const removed = stripGeneratedArtifacts(dir);

    expect(removed).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'hooks', 'claude.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(true);
  });

  it('removes only generated files from a mixed tree and returns sorted relative paths', () => {
    write('hooks/claude.yaml', 'PreToolUse: []\n');
    write('hooks/claude.json', applyJsonSentinel({ hooks: {} }, 'hooks/claude.yaml'));
    write('hooks/hooks.json', applyJsonSentinel({ hooks: {} }, 'hooks/claude.yaml'));
    write('README.md', '# readme\n');
    write('gemini-extension.json', JSON.stringify({ name: 'skill-evaluator' }, null, 2) + '\n');

    const removed = stripGeneratedArtifacts(dir);

    // Only the two sentinel-carrying hook JSONs are removed; sorted by relative path.
    expect(removed).toEqual([path.join('hooks', 'claude.json'), path.join('hooks', 'hooks.json')]);
    expect(fs.existsSync(path.join(dir, 'hooks', 'claude.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'gemini-extension.json'))).toBe(true);
  });

  it('leaves directories in place (removes files, not their containing dirs)', () => {
    write('hooks/claude.json', applyJsonSentinel({ hooks: {} }, 'hooks/claude.yaml'));

    stripGeneratedArtifacts(dir);

    expect(fs.existsSync(path.join(dir, 'hooks'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'hooks')).isDirectory()).toBe(true);
  });

  it('returns an empty list for a tree with no generated artifacts', () => {
    write('README.md', '# nothing generated here\n');
    expect(stripGeneratedArtifacts(dir)).toEqual([]);
  });
});
