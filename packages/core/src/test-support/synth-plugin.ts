/**
 * Test fixture builder: synthesize a temporary repo containing a real plugin plus an
 * `aipm.config.ts` and marketplace files, so the build/validate orchestrators have a complete
 * plugin to operate on.
 *
 * The synthesized repo must represent author-authored **source** state, not a post-build state:
 * this helper recursively copies `${TEMPLATE_REPO}/plugins/skill-evaluator`, then strips every
 * toolkit-GENERATED artifact from the copy (see {@link stripGeneratedArtifacts}) so the build
 * under test is the only thing that (re)creates them. It writes an `aipm.config.ts` declaring the
 * requested targets — overwriting the one the template plugin happens to ship, to control the
 * support envelope per test — and copies both marketplace.json files to the temp repo root so
 * marketplace-registration passes.
 *
 * Without the strip, the committed generated hook JSONs (`hooks/claude.json`, `hooks/hooks.json`)
 * would be copied in verbatim, and "no mechanical output" assertions (e.g. building only
 * `cursor`/`vercel`) would see files the fixture itself supplied rather than ones the build
 * emitted — a false pass-or-fail unrelated to build behavior.
 *
 * Developer-machine-only: depends on a local template checkout (see {@link TEMPLATE_REPO}).
 *
 * @see docs/specs/architecture.md §6.1 (aipm.config.ts), §4.4 (marketplace registry)
 * @see docs/specs/architecture.md §4.3 (author-authored vs toolkit-generated — sentinel carriers)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { hasSentinel } from '../pipeline/sentinel.js';
import type { TargetId } from '../pipeline/types.js';
import { TEMPLATE_REPO } from './template-repo.js';

/** The plugin copied by {@link synthPluginRepo}. */
export const SYNTH_PLUGIN_NAME = 'skill-evaluator';

/** Absolute path to the source plugin in the template checkout. */
const TEMPLATE_PLUGIN_DIR = path.join(TEMPLATE_REPO, 'plugins', SYNTH_PLUGIN_NAME);

/** Absolute paths to the committed dist oracles for the synth plugin. */
export const ORACLE_GEMINI_DIR = path.join(TEMPLATE_REPO, 'dist', 'gemini', SYNTH_PLUGIN_NAME);
export const ORACLE_KIRO_DIR = path.join(TEMPLATE_REPO, 'dist', 'kiro', SYNTH_PLUGIN_NAME);

/** Every target the real skill-evaluator plugin provides artifacts for. */
export const ALL_SYNTH_TARGETS: readonly TargetId[] = [
  'claude',
  'cursor',
  'gemini',
  'kiro',
  'vercel',
];

/** A handle to a synthesized repo, with cleanup. */
export interface SynthRepo {
  /** Absolute repo root (contains `plugins/` and `dist/`). */
  repoRoot: string;
  /** Absolute path to the single synthesized plugin directory. */
  pluginDir: string;
  /** Remove the temp repo. */
  cleanup: () => void;
}

/** Recursively copy a directory tree. */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/** Suffix of a sidecar sentinel file (`<artifact>.generated`, §4.3). */
const SIDECAR_SUFFIX = '.generated';

/** Recursively collect every file (absolute path) under `dir`. */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(abs));
    } else {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Whether a file embeds a sentinel in its own bytes — the json-field carrier (the hook JSON
 * `_generated` field) or the inline-comment carrier (plain-text generated files), §4.3. The
 * sidecar carrier is handled separately because a sidecar-marked artifact carries no in-band
 * sentinel by design. Binary/non-text files fail the string checks and are kept.
 */
function hasEmbeddedSentinel(absPath: string): boolean {
  const content = fs.readFileSync(absPath, 'utf-8');
  return hasSentinel(content, 'json-field') || hasSentinel(content, 'inline');
}

/**
 * Remove every toolkit-generated artifact under `pluginDir`, restoring the tree to author-authored
 * source state. Called after {@link copyDir} so the build under test is the sole producer of
 * generated files; see the module doc for why this matters.
 *
 * Recognizes all three §4.3 sentinel carriers:
 * - **json-field / inline** — the file embeds the sentinel in its own bytes; the file is removed.
 * - **sidecar** — a `<artifact>.generated` marker sits beside a strict-schema artifact that is
 *   itself left untouched (the host rejects unknown fields, so the sentinel can't live inline).
 *   BOTH the marker and the companion artifact it marks are removed, since the artifact is just
 *   as generated as an in-band carrier — removing only the marker would leave generated output
 *   in the fixture.
 *
 * Returns the plugin-relative paths removed (sorted) — handy for assertions and debugging.
 */
export function stripGeneratedArtifacts(pluginDir: string): string[] {
  const toRemove = new Set<string>();
  for (const abs of collectFiles(pluginDir)) {
    if (abs.endsWith(SIDECAR_SUFFIX)) {
      toRemove.add(abs); // the sidecar marker itself
      toRemove.add(abs.slice(0, -SIDECAR_SUFFIX.length)); // the companion artifact it marks
    } else if (hasEmbeddedSentinel(abs)) {
      toRemove.add(abs);
    }
  }

  const removed: string[] = [];
  for (const abs of toRemove) {
    // A companion artifact named by a dangling sidecar may not exist — only remove real files.
    if (fs.existsSync(abs)) {
      fs.rmSync(abs);
      removed.push(path.relative(pluginDir, abs));
    }
  }
  return removed.sort();
}

/** Render an `aipm.config.ts` source string for the given targets. */
function renderAipmConfig(targets: readonly TargetId[], version = '0.1.0'): string {
  const targetList = targets.map((t) => `'${t}'`).join(', ');
  return `import { defineConfig } from '@ai-plugin-marketplace/core';

export default defineConfig({
  version: '${version}',
  targets: [${targetList}],
});
`;
}

/**
 * Synthesize a temp repo with the skill-evaluator plugin and an `aipm.config.ts` declaring
 * `targets`. Copies both marketplace.json files to the repo root.
 *
 * @param targets - Targets to declare in the config. Defaults to all the plugin provides.
 * @param mutate - Optional hook to mutate the plugin tree after copy (e.g. inject a stray file).
 */
export function synthPluginRepo(
  targets: readonly TargetId[] = ALL_SYNTH_TARGETS,
  mutate?: (pluginDir: string, repoRoot: string) => void,
): SynthRepo {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-synth-'));
  const pluginDir = path.join(repoRoot, 'plugins', SYNTH_PLUGIN_NAME);

  copyDir(TEMPLATE_PLUGIN_DIR, pluginDir);

  // Strip build-generated artifacts so the copy is author-source state; the build under test is
  // the sole producer of generated files (§4.3). Otherwise the committed hook JSONs would be
  // copied in and "no mechanical output" assertions would observe the fixture, not the build.
  stripGeneratedArtifacts(pluginDir);

  // Write the config declaring the requested target envelope, overwriting whatever the template
  // plugin ships so each test controls its own envelope.
  fs.writeFileSync(path.join(pluginDir, 'aipm.config.ts'), renderAipmConfig(targets), 'utf-8');

  // Copy marketplace files so marketplace-registration passes.
  for (const marketplaceRel of [
    '.claude-plugin/marketplace.json',
    '.cursor-plugin/marketplace.json',
  ]) {
    const src = path.join(TEMPLATE_REPO, marketplaceRel);
    if (fs.existsSync(src)) {
      const dest = path.join(repoRoot, marketplaceRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  mutate?.(pluginDir, repoRoot);

  return {
    repoRoot,
    pluginDir,
    cleanup: () => {
      if (fs.existsSync(repoRoot)) fs.rmSync(repoRoot, { recursive: true });
    },
  };
}
