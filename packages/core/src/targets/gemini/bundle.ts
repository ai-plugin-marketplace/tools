/**
 * I/O layer for the Gemini CLI target: copies a plugin's canonical files into a
 * standalone export directory, rewriting agent tool names along the way.
 *
 * @see docs/specs/architecture.md §7 (mechanical transformations)
 * @see docs/specs/architecture.md §12.4 (transform step + per-target folder layout)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { convertClaudeHooksYamlToGeminiJson, rewriteAgentFrontmatterTools } from './transform.js';

// ---------------------------------------------------------------------------
// Internal file-system helpers (mirrors build-standalone.ts utilities)
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

function cleanDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
}

/** Collect all file paths under `dir` relative to `dir`. */
function collectRelativePaths(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const sub of collectRelativePaths(path.join(dir, entry.name))) {
        results.push(path.join(entry.name, sub));
      }
    } else {
      results.push(entry.name);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Agent rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite all `.md` files inside `agentsDir` in-place, translating Claude Code tool
 * names to Gemini CLI equivalents. Returns a map of filename → dropped tools.
 */
function rewriteAgentsDir(agentsDir: string): Record<string, string[]> {
  const droppedToolsByAgent: Record<string, string[]> = {};

  if (!fs.existsSync(agentsDir)) return droppedToolsByAgent;

  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;

    const filePath = path.join(agentsDir, file);
    const original = fs.readFileSync(filePath, 'utf-8');
    const { content, droppedTools } = rewriteAgentFrontmatterTools(original);

    fs.writeFileSync(filePath, content, 'utf-8');

    if (droppedTools.length > 0) {
      droppedToolsByAgent[file] = droppedTools;
    }
  }

  return droppedToolsByAgent;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the Gemini CLI standalone export for a single plugin. Copies the canonical
 * set of files/dirs from `pluginDir` into `destDir`, rewriting agent `.md` files'
 * tool names along the way. Matches the output of `buildGeminiStandalone` in the
 * template's `build-standalone.ts`.
 *
 * Impure (I/O): reads from pluginDir, writes to destDir. Clears destDir first.
 *
 * @param pluginDir - Absolute path to the source plugin directory.
 * @param destDir   - Absolute path to the destination directory (cleared before writing).
 * @returns `emitted`: paths relative to destDir for every file written.
 *          `droppedToolsByAgent`: map of agent filename → dropped Claude tool names.
 */
export function bundleGeminiPlugin(
  pluginDir: string,
  destDir: string,
): { emitted: string[]; droppedToolsByAgent: Record<string, string[]> } {
  cleanDir(destDir);

  // ── Flat files (only if present) ──────────────────────────────────────────
  // README.md/LICENSE are deliberately NOT copied here: the template repo (commit d2d9923,
  // "adopt generated registries and repo-root Gemini/Kiro emission") moved them from
  // per-plugin source to the repo ROOT, where they are canonical, author-owned, SHARED
  // artifacts backing the single Gemini extension by virtue of already living beside it
  // (GeneratedFile.target's 'shared' model, per #54) rather than a per-plugin generated copy.
  // Emitting them here would (a) diverge from the template's real `dist/gemini/<plugin>/`
  // oracle, which no longer contains them, and (b) for repo-root single-artifact-host
  // emission, collide with the repo's own root README/LICENSE via the `root-artifact-collision`
  // guard (build.ts) — generation must never try to own files it does not generate.
  const flatFiles = ['gemini-extension.json', 'GEMINI.md'];
  for (const name of flatFiles) {
    copyIfExists(path.join(pluginDir, name), path.join(destDir, name));
  }

  // ── Directories: skills/ and agents/ ─────────────────────────────────────
  const plainDirs = ['skills', 'agents'];
  for (const dir of plainDirs) {
    copyIfExists(path.join(pluginDir, dir), path.join(destDir, dir));
  }

  // Rewrite agent tool names after copying
  const droppedToolsByAgent = rewriteAgentsDir(path.join(destDir, 'agents'));

  // ── commands/: .toml files only ───────────────────────────────────────────
  const commandsSrc = path.join(pluginDir, 'commands');
  const commandsDest = path.join(destDir, 'commands');
  if (fs.existsSync(commandsSrc)) {
    const tomlFiles = fs.readdirSync(commandsSrc).filter((f) => f.endsWith('.toml'));
    if (tomlFiles.length > 0) {
      fs.mkdirSync(commandsDest, { recursive: true });
      for (const file of tomlFiles) {
        copyFile(path.join(commandsSrc, file), path.join(commandsDest, file));
      }
    }
  }

  // ── hooks/hooks.json: translate Claude YAML → Gemini JSON ────────────────
  // Gemini CLI looks for `hooks/hooks.json` regardless of the YAML source filename.
  // Try claude.yaml first, then claude.yml, matching build-hooks.ts behaviour.
  const hooksSrc = path.join(pluginDir, 'hooks');
  const yamlCandidates = ['claude.yaml', 'claude.yml'];
  for (const candidate of yamlCandidates) {
    const yamlPath = path.join(hooksSrc, candidate);
    if (fs.existsSync(yamlPath)) {
      const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
      const jsonContent = convertClaudeHooksYamlToGeminiJson(yamlContent);
      const hooksDestDir = path.join(destDir, 'hooks');
      fs.mkdirSync(hooksDestDir, { recursive: true });
      fs.writeFileSync(path.join(hooksDestDir, 'hooks.json'), jsonContent, 'utf-8');
      break;
    }
  }

  const emitted = collectRelativePaths(destDir);

  return { emitted, droppedToolsByAgent };
}
