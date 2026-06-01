/**
 * Test fixture builder: synthesize a temporary repo containing a real plugin plus an
 * `aipm.config.ts` and marketplace files, so the build/validate orchestrators have a complete
 * plugin to operate on.
 *
 * The real template plugin `plugins/skill-evaluator/` does not yet ship an `aipm.config.ts`
 * (Phase B adds it), so orchestrator tests must construct one. This helper recursively copies
 * `${TEMPLATE_REPO}/plugins/skill-evaluator`, writes a config with the requested targets, and
 * copies both marketplace.json files to the temp repo root so marketplace-registration passes.
 *
 * Developer-machine-only: depends on a local template checkout (see {@link TEMPLATE_REPO}).
 *
 * @see docs/specs/architecture.md §6.1 (aipm.config.ts), §4.4 (marketplace registry)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

  // Write the config that the source plugin lacks.
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
