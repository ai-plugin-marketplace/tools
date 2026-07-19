/**
 * Kiro plugin bundler (I/O layer).
 *
 * Reads from a plugin source directory and writes a Kiro-compatible standalone
 * export to a destination directory. Matches the output of `buildKiroStandalone`
 * in build-standalone.ts of the template repository.
 *
 * @see docs/specs/architecture.md §12.4, §12.5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildKiroAgentConfig } from './transform.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

function copyIfExists(src: string, dest: string): boolean {
  if (!fs.existsSync(src)) return false;
  if (fs.statSync(src).isDirectory()) {
    copyDir(src, dest);
  } else {
    copyFile(src, dest);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return type for `bundleKiroPlugin`. */
export interface BundleKiroPluginResult {
  /** Relative paths of all files/directories emitted (same semantics as build-standalone.ts). */
  emitted: string[];
  /** Names of agents generated (without the .json extension). */
  agentsGenerated: string[];
}

/**
 * Build the Kiro standalone export for a single plugin.
 *
 * Copies canonical files and directories from `pluginDir` to `destDir`, and
 * generates `.kiro/agents/<name>.json` from any agent `.md` files found in
 * `pluginDir/agents/`. Clears `destDir` before writing.
 *
 * Files copied (if present): `POWER.md`, `mcp.json`. README.md/LICENSE are deliberately NOT
 * copied — the template repo (commit d2d9923, "adopt generated registries and repo-root
 * Gemini/Kiro emission") moved them from per-plugin source to the repo ROOT, where they are
 * canonical, author-owned, SHARED artifacts backing the single Kiro power by virtue of already
 * living beside it (GeneratedFile.target's 'shared' model, per #54) rather than a per-plugin
 * generated copy. See `gemini/bundle.ts` for the parallel reasoning.
 * Dirs copied (if present): `steering/`, `skills/`.
 * Agent `.md` files are compiled to `.kiro/agents/<name>.json` via
 * `buildKiroAgentConfig`, serialised with 2-space indent + trailing newline.
 *
 * Impure (I/O): reads from `pluginDir`, writes to `destDir`.
 */
export function bundleKiroPlugin(pluginDir: string, destDir: string): BundleKiroPluginResult {
  // Clear dest first, matching buildKiroStandalone's cleanDir behaviour.
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true });
  }

  const emitted: string[] = [];
  const agentsGenerated: string[] = [];

  // Canonical files (README.md/LICENSE are intentionally excluded — see module doc above)
  const files: string[] = ['POWER.md', 'mcp.json'];
  for (const file of files) {
    if (copyIfExists(path.join(pluginDir, file), path.join(destDir, file))) {
      emitted.push(file);
    }
  }

  // Canonical directories
  const dirs: string[] = ['steering', 'skills'];
  for (const dir of dirs) {
    if (copyIfExists(path.join(pluginDir, dir), path.join(destDir, dir))) {
      emitted.push(`${dir}/`);
    }
  }

  // Generate .kiro/agents/<name>.json from agent .md files
  const agentsSrc = path.join(pluginDir, 'agents');
  if (fs.existsSync(agentsSrc)) {
    const kiroAgentsDir = path.join(destDir, '.kiro', 'agents');
    let anyGenerated = false;

    for (const file of fs.readdirSync(agentsSrc)) {
      if (!file.endsWith('.md')) continue;

      const mdContent = fs.readFileSync(path.join(agentsSrc, file), 'utf-8');
      const fallbackName = file.replace(/\.md$/, '');
      const config = buildKiroAgentConfig(mdContent, fallbackName);
      if (!config) continue;

      fs.mkdirSync(kiroAgentsDir, { recursive: true });
      const jsonName = file.replace(/\.md$/, '.json');
      fs.writeFileSync(path.join(kiroAgentsDir, jsonName), JSON.stringify(config, null, 2) + '\n');
      agentsGenerated.push(fallbackName);
      anyGenerated = true;
    }

    if (anyGenerated) {
      emitted.push('.kiro/agents/');
    }
  }

  return { emitted, agentsGenerated };
}
