/**
 * Tests for the Kiro plugin bundler (bundle.ts).
 *
 * Parity tests compare bundleKiroPlugin output against the committed oracle in
 * dist/kiro/skill-evaluator/ from the template repository.
 *
 * Runs with positive coverage in CI against the template revision pinned in
 * `.github/template-repo.rev` (see issue #86); skips locally when no complete template checkout
 * is configured via `AIPM_TEMPLATE_REPO`.
 *
 * The `@see` links below resolve at `ai-plugin-marketplace/template`'s `main` tip for
 * readability, but the actual oracle this suite compares against is whatever revision is pinned
 * in `.github/template-repo.rev` — if this suite fails, diff against that pinned SHA
 * (`https://github.com/ai-plugin-marketplace/template/tree/<pinned-sha>/...`), not `main`, since
 * the two can diverge between pin bumps.
 *
 * @see ../../../../../.github/template-repo.rev (the pinned revision the oracle below is read from)
 * @see https://github.com/ai-plugin-marketplace/template/blob/main/src/build-standalone.ts
 * @see https://github.com/ai-plugin-marketplace/template/tree/main/dist/kiro/skill-evaluator
 * @see docs/specs/architecture.md §12.4
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AIPM_REQUIRE_TEMPLATE,
  assertTemplateRepoAvailable,
  shouldSkipTemplateRepoSuite,
  TEMPLATE_REPO,
  TEMPLATE_REPO_AVAILABLE,
} from '../../test-support/template-repo.js';
import { bundleKiroPlugin } from './bundle.js';

const SKIP_PARITY_SUITE = shouldSkipTemplateRepoSuite({
  available: TEMPLATE_REPO_AVAILABLE,
  required: AIPM_REQUIRE_TEMPLATE,
});

function requireTemplateRepo(): void {
  assertTemplateRepoAvailable({
    available: TEMPLATE_REPO_AVAILABLE,
    required: AIPM_REQUIRE_TEMPLATE,
    templateRoot: TEMPLATE_REPO,
  });
}

// ---------------------------------------------------------------------------
// Path constants — absolute to avoid cwd dependency
// ---------------------------------------------------------------------------

const TEMPLATE_ROOT = TEMPLATE_REPO;
const PLUGIN_SRC = path.join(TEMPLATE_ROOT, 'plugins', 'skill-evaluator');
const ORACLE_DIR = path.join(TEMPLATE_ROOT, 'dist', 'kiro', 'skill-evaluator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all file paths relative to `rootDir` within `dir`,
 * sorted for deterministic comparison.
 */
function collectRelativePaths(dir: string, rootDir?: string): string[] {
  const base = rootDir ?? dir;
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRelativePaths(full, base));
    } else {
      results.push(path.relative(base, full));
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-bundle-test-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Parity tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_PARITY_SUITE)('bundleKiroPlugin — skill-evaluator parity', () => {
  beforeAll(requireTemplateRepo);

  it('produces the same file tree as the oracle dist/kiro/skill-evaluator/', () => {
    const destDir = path.join(tmpDir, 'output');
    bundleKiroPlugin(PLUGIN_SRC, destDir);

    const actual = collectRelativePaths(destDir);
    const expected = collectRelativePaths(ORACLE_DIR);

    expect(actual).toEqual(expected);
  });

  it('produces byte-identical non-JSON files to the oracle', () => {
    const destDir = path.join(tmpDir, 'output');
    bundleKiroPlugin(PLUGIN_SRC, destDir);

    const oraclePaths = collectRelativePaths(ORACLE_DIR);
    const nonJsonPaths = oraclePaths.filter((p) => !p.endsWith('.json'));

    for (const relPath of nonJsonPaths) {
      const actualContent = fs.readFileSync(path.join(destDir, relPath), 'utf-8');
      const expectedContent = fs.readFileSync(path.join(ORACLE_DIR, relPath), 'utf-8');
      expect(actualContent, `mismatch at ${relPath}`).toBe(expectedContent);
    }
  });

  it('produces structurally identical JSON files to the oracle (parsed comparison)', () => {
    const destDir = path.join(tmpDir, 'output');
    bundleKiroPlugin(PLUGIN_SRC, destDir);

    const oraclePaths = collectRelativePaths(ORACLE_DIR);
    const jsonPaths = oraclePaths.filter((p) => p.endsWith('.json'));

    for (const relPath of jsonPaths) {
      const actualJson = JSON.parse(
        fs.readFileSync(path.join(destDir, relPath), 'utf-8'),
      ) as unknown;
      const expectedJson = JSON.parse(
        fs.readFileSync(path.join(ORACLE_DIR, relPath), 'utf-8'),
      ) as unknown;
      expect(actualJson, `JSON mismatch at ${relPath}`).toEqual(expectedJson);
    }
  });

  it('produces experimenter.json with exact serialisation matching the oracle (2-space + trailing newline)', () => {
    const destDir = path.join(tmpDir, 'output');
    bundleKiroPlugin(PLUGIN_SRC, destDir);

    const actual = fs.readFileSync(
      path.join(destDir, '.kiro', 'agents', 'experimenter.json'),
      'utf-8',
    );
    const expected = fs.readFileSync(
      path.join(ORACLE_DIR, '.kiro', 'agents', 'experimenter.json'),
      'utf-8',
    );
    expect(actual).toBe(expected);
  });

  it('produces test-subject.json with exact serialisation matching the oracle', () => {
    const destDir = path.join(tmpDir, 'output');
    bundleKiroPlugin(PLUGIN_SRC, destDir);

    const actual = fs.readFileSync(
      path.join(destDir, '.kiro', 'agents', 'test-subject.json'),
      'utf-8',
    );
    const expected = fs.readFileSync(
      path.join(ORACLE_DIR, '.kiro', 'agents', 'test-subject.json'),
      'utf-8',
    );
    expect(actual).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Return value tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_PARITY_SUITE)('bundleKiroPlugin — return values', () => {
  beforeAll(requireTemplateRepo);

  it('includes expected emitted paths', () => {
    const destDir = path.join(tmpDir, 'output');
    const { emitted } = bundleKiroPlugin(PLUGIN_SRC, destDir);

    expect(emitted).toContain('POWER.md');
    expect(emitted).toContain('mcp.json');
    expect(emitted).toContain('steering/');
    expect(emitted).toContain('skills/');
    expect(emitted).toContain('.kiro/agents/');
  });

  it('lists both agent names in agentsGenerated', () => {
    const destDir = path.join(tmpDir, 'output');
    const { agentsGenerated } = bundleKiroPlugin(PLUGIN_SRC, destDir);

    expect(agentsGenerated).toHaveLength(2);
    expect(agentsGenerated).toContain('experimenter');
    expect(agentsGenerated).toContain('test-subject');
  });
});

describe('bundleKiroPlugin — README.md/LICENSE exclusion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-bundle-readme-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('does not include README.md/LICENSE even when present in pluginDir (root-owned shared artifacts)', () => {
    // Regression for issue #89: the template repo (commit d2d9923) moved README.md/LICENSE from
    // per-plugin source to the repo root, where they are canonical shared artifacts (GeneratedFile
    // .target's 'shared' model, #54) — the bundler must never treat them as per-plugin bundle
    // content, even when a stray copy exists in pluginDir.
    const destDir = path.join(tmpDir, 'out');
    const scratchPlugin = path.join(tmpDir, 'plugin-with-readme');
    fs.mkdirSync(scratchPlugin, { recursive: true });
    fs.writeFileSync(path.join(scratchPlugin, 'POWER.md'), '---\nname: x\n---\n# x\n');
    fs.writeFileSync(path.join(scratchPlugin, 'README.md'), '# stray\n');
    fs.writeFileSync(path.join(scratchPlugin, 'LICENSE'), 'MIT\n');

    const { emitted } = bundleKiroPlugin(scratchPlugin, destDir);

    expect(emitted).not.toContain('README.md');
    expect(emitted).not.toContain('LICENSE');
    expect(fs.existsSync(path.join(destDir, 'README.md'))).toBe(false);
    expect(fs.existsSync(path.join(destDir, 'LICENSE'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotence / clean-first tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_PARITY_SUITE)('bundleKiroPlugin — clean-first behaviour', () => {
  beforeAll(requireTemplateRepo);

  it('clears destDir content before writing when destDir already has files', () => {
    const destDir = path.join(tmpDir, 'output');

    // Populate with stale content
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'stale-file.txt'), 'should be gone');
    fs.mkdirSync(path.join(destDir, 'stale-dir'), { recursive: true });
    fs.writeFileSync(path.join(destDir, 'stale-dir', 'nested.txt'), 'also gone');

    bundleKiroPlugin(PLUGIN_SRC, destDir);

    expect(fs.existsSync(path.join(destDir, 'stale-file.txt'))).toBe(false);
    expect(fs.existsSync(path.join(destDir, 'stale-dir'))).toBe(false);
  });

  it('produces the same output on a second run (idempotent)', () => {
    const destDir = path.join(tmpDir, 'output');

    bundleKiroPlugin(PLUGIN_SRC, destDir);
    const firstRun = collectRelativePaths(destDir);

    bundleKiroPlugin(PLUGIN_SRC, destDir);
    const secondRun = collectRelativePaths(destDir);

    expect(secondRun).toEqual(firstRun);
  });
});

// ---------------------------------------------------------------------------
// Partial plugin (missing optional files)
// ---------------------------------------------------------------------------

describe('bundleKiroPlugin — partial plugin source', () => {
  it('omits entries from emitted when optional files are absent', () => {
    // Create a minimal plugin with only POWER.md and no agents/steering/skills
    const minimalPlugin = path.join(tmpDir, 'minimal-plugin');
    fs.mkdirSync(minimalPlugin);
    fs.writeFileSync(path.join(minimalPlugin, 'POWER.md'), '---\nname: minimal\n---\n');

    const destDir = path.join(tmpDir, 'minimal-output');
    const { emitted, agentsGenerated } = bundleKiroPlugin(minimalPlugin, destDir);

    expect(emitted).toContain('POWER.md');
    expect(emitted).not.toContain('mcp.json');
    expect(emitted).not.toContain('steering/');
    expect(emitted).not.toContain('skills/');
    expect(emitted).not.toContain('.kiro/agents/');
    expect(agentsGenerated).toHaveLength(0);
  });
});
