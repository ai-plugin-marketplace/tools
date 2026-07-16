/**
 * End-to-end test for the public `lint()` entry point: discovers a plugin under a repo root and
 * runs every rule against it, producing both migrated-legacy diagnostics (carrying `legacyCode`)
 * and new-rule diagnostics.
 *
 * @see docs/specs/lint-engine.md §4.1
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lint } from './engine.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-lint-engine-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function write(rel: string, content: string | object): void {
  const full = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    'utf-8',
  );
}

describe('lint()', () => {
  it('runs both migrated and new rules against a discovered plugin', async () => {
    write(
      'plugins/my-plugin/aipm.config.ts',
      `import { defineConfig } from '@ai-plugin-marketplace/core';\n` +
        `export default defineConfig({ version: '1.0.0', targets: ['claude'] });\n`,
    );
    // A manifest field referencing a nonexistent agent file — should surface both the legacy
    // schema-invalid-style path-existence check AND the new broken-file-ref rule.
    write('plugins/my-plugin/.claude-plugin/plugin.json', {
      name: 'my-plugin',
      agents: './agents/missing.md',
    });

    const result = await lint(repoRoot);

    // A migrated-legacy diagnostic (from the per-target schema/adherence rules) carries legacyCode.
    const legacyDiagnostics = result.diagnostics.filter((d) => d.legacyCode !== undefined);
    expect(legacyDiagnostics.length).toBeGreaterThan(0);

    // A new-rule diagnostic (broken-file-ref) has no legacyCode.
    const brokenRefDiagnostics = result.diagnostics.filter(
      (d) => d.ruleId === 'correctness/broken-file-ref',
    );
    expect(brokenRefDiagnostics).toHaveLength(1);
    expect(brokenRefDiagnostics[0]?.legacyCode).toBeUndefined();
    expect(brokenRefDiagnostics[0]?.message).toContain('./agents/missing.md');
  });

  it('is silent (no diagnostics) for a fully conformant single-target plugin', async () => {
    write(
      'plugins/clean-plugin/aipm.config.ts',
      `import { defineConfig } from '@ai-plugin-marketplace/core';\n` +
        `export default defineConfig({ version: '1.0.0', targets: ['claude'] });\n`,
    );
    write('plugins/clean-plugin/.claude-plugin/plugin.json', { name: 'clean-plugin' });
    write('.claude-plugin/marketplace.json', {
      name: 'test-marketplace',
      plugins: [{ name: 'clean-plugin', source: './plugins/clean-plugin' }],
    });

    const result = await lint(repoRoot);
    expect(result.diagnostics).toEqual([]);
  });
});
