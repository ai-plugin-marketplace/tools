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

/** Every target the synthesized skill-evaluator plugin provides artifacts for. */
export const ALL_SYNTH_TARGETS: readonly TargetId[] = [
  'claude',
  'codex',
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

/** Optional shared metadata an `aipm.config.ts` may carry (registry-generation source fields). */
interface SynthConfigMetadata {
  /** Maps to the generated registry entry's `description` (Claude/Cursor). */
  description?: string;
  /** Maps to the generated registry entry's `tags` (Claude/Cursor). */
  keywords?: readonly string[];
}

/** Render an `aipm.config.ts` source string for the given targets and optional metadata. */
function renderAipmConfig(
  targets: readonly TargetId[],
  meta: SynthConfigMetadata = {},
  version = '0.1.0',
): string {
  const targetList = targets.map((t) => `'${t}'`).join(', ');
  const lines = [`  version: '${version}',`, `  targets: [${targetList}],`];
  if (meta.description !== undefined) {
    lines.push(`  description: ${JSON.stringify(meta.description)},`);
  }
  if (meta.keywords !== undefined) {
    lines.push(`  keywords: ${JSON.stringify(meta.keywords)},`);
  }
  return `import { defineConfig } from '@ai-plugin-marketplace/core';

export default defineConfig({
${lines.join('\n')}
});
`;
}

/**
 * Render an `aipm.workspace.ts` source string. Its presence at a repo root opts the repo into
 * marketplace-registry generation.
 */
function renderAipmWorkspace(marketplace: {
  name: string;
  owner?: { name: string; email?: string };
  description?: string;
}): string {
  return `import { defineWorkspace } from '@ai-plugin-marketplace/core';

export default defineWorkspace(${JSON.stringify({ marketplace }, null, 2)});
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

  // The template plugin does not ship a Codex manifest. Synthesize one (matching the directory
  // basename so name-consistency passes) when codex is in the envelope.
  if (targets.includes('codex')) {
    const codexManifest = {
      schemaVersion: '0.1.0',
      name: SYNTH_PLUGIN_NAME,
      version: '0.0.1',
    };
    const dest = path.join(pluginDir, '.codex-plugin', 'plugin.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(codexManifest, null, 2)}\n`, 'utf-8');
  }

  // Copy the string-source marketplace files so marketplace-registration passes for claude/cursor.
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

  // The template repo has no Codex marketplace yet, so synthesize the object-source registry at
  // `.agents/plugins/marketplace.json` (the Codex repo-marketplace location) when codex is in the
  // envelope, so marketplace-registration passes for codex too.
  if (targets.includes('codex')) {
    const codexMarketplace = {
      name: 'test-marketplace',
      interface: { displayName: 'Test Marketplace' },
      plugins: [
        {
          name: SYNTH_PLUGIN_NAME,
          source: { source: 'local', path: `./plugins/${SYNTH_PLUGIN_NAME}` },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    };
    const dest = path.join(repoRoot, '.agents', 'plugins', 'marketplace.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(codexMarketplace, null, 2)}\n`, 'utf-8');
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

// ---------------------------------------------------------------------------
// Lightweight, template-independent fixtures for registry-generation tests
// ---------------------------------------------------------------------------

/** A single plugin's declaration for {@link synthRegistryRepo}. */
export interface SynthRegistryPlugin {
  /** Plugin directory basename (becomes the registry entry `name`). */
  name: string;
  /** Declared support envelope. */
  targets: readonly TargetId[];
  /** Optional shared metadata mapped to the generated registry entry. */
  meta?: SynthConfigMetadata;
  /**
   * Optional extra source files to write under the plugin directory, keyed by POSIX-relative path
   * (e.g. `gemini-extension.json`, `GEMINI.md`, `commands/foo.toml`, `POWER.md`, `mcp.json`). These
   * are the author-authored host artifacts the single-artifact-host bundlers copy to the repo root.
   * Parent directories are created automatically.
   */
  files?: Record<string, string>;
}

/** A handle to a synthesized registry-generation repo, with cleanup. */
export interface SynthRegistryRepo {
  /** Absolute repo root (contains `plugins/` and, when requested, `aipm.workspace.ts`). */
  repoRoot: string;
  /** Remove the temp repo. */
  cleanup: () => void;
}

/**
 * Synthesize a temp repo with one or more minimal plugins (each just an `aipm.config.ts`) and,
 * optionally, an `aipm.workspace.ts` to opt the repo into registry generation. Unlike
 * {@link synthPluginRepo}, this does NOT copy the heavy template plugin — registry generation only
 * reads each plugin's `aipm.config.ts` (envelope + description/keywords) plus the directory name,
 * so a minimal fixture is sufficient and keeps these tests independent of the template checkout.
 *
 * @param plugins - The plugins to create under `plugins/<name>/`.
 * @param workspace - Workspace metadata to write to `aipm.workspace.ts`; omit to leave it absent
 *   (the backward-compat path).
 */
export function synthRegistryRepo(
  plugins: readonly SynthRegistryPlugin[],
  workspace?: { name: string; owner?: { name: string; email?: string }; description?: string },
): SynthRegistryRepo {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-synth-reg-'));

  for (const plugin of plugins) {
    const pluginDir = path.join(repoRoot, 'plugins', plugin.name);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'aipm.config.ts'),
      renderAipmConfig(plugin.targets, plugin.meta ?? {}),
      'utf-8',
    );
    // Write any author-authored host source files (e.g. gemini-extension.json, POWER.md) so the
    // single-artifact-host bundlers have something to copy to the repo root.
    for (const [rel, content] of Object.entries(plugin.files ?? {})) {
      const dest = path.join(pluginDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, 'utf-8');
    }
  }

  if (workspace !== undefined) {
    fs.writeFileSync(
      path.join(repoRoot, 'aipm.workspace.ts'),
      renderAipmWorkspace(workspace),
      'utf-8',
    );
  }

  return {
    repoRoot,
    cleanup: () => {
      if (fs.existsSync(repoRoot)) fs.rmSync(repoRoot, { recursive: true });
    },
  };
}
