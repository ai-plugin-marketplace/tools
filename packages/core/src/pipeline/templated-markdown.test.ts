/**
 * Regression coverage for issue #93: templated Markdown outputs must emit REAL backtick bytes
 * (`0x60`), never the two-character sequence backslash+backtick (`0x5c 0x60`).
 *
 * Root cause: several template modules tag their embedded Markdown with `String.raw` (the
 * project convention for multi-line embedded-language literals — see
 * `tagged-template-literals-for-languages`), which does NOT interpret escape sequences. Writing
 * an escaped backtick (`` \` ``) inside a `String.raw`-tagged template — the only way to embed a
 * literal backtick character in an ordinary (non-raw) template literal — therefore left the
 * literal two-byte sequence `5c 60` in the emitted file instead of producing the single real
 * backtick byte `60`. The fix interpolates a `bt = '\`'` constant instead of escaping the backtick
 * in the template source.
 *
 * This suite scans every templated `.md` file produced by both `aipm init` (`runInit`) and
 * `aipm scaffold` (`runScaffold`, across every known target) so the whole class of outputs is
 * covered, not just the two files (`README.md`, `POWER.md`) originally observed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runInit } from './init.js';
import { runScaffold } from './scaffold.js';
import { TARGET_IDS } from './types.js';

/** The literal two-byte sequence a raw-tagged template wrongly emits for an escaped backtick. */
const LITERAL_BACKSLASH_BACKTICK = Buffer.from([0x5c, 0x60]);

/** Recursively collect every `.md` file under `dir`, returning paths relative to `dir`. */
function collectMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Assert that `filePath` contains zero occurrences of the literal `5c 60` (`\` + `` ` ``) byte
 * sequence, at the byte level — not just at the string level — so a fix that "looks" correct in a
 * UTF-8-decoded string comparison can't mask a raw-byte regression.
 */
function expectNoLiteralBackslashBacktick(filePath: string): void {
  const bytes = fs.readFileSync(filePath);
  const index = bytes.indexOf(LITERAL_BACKSLASH_BACKTICK);
  if (index !== -1) {
    const context = bytes.subarray(Math.max(0, index - 20), index + 20).toString('utf-8');
    throw new Error(
      `${filePath} contains a literal backslash-backtick byte sequence (5c 60) at offset ${String(index)}: ...${context}...`,
    );
  }
}

let tmpDir: string;

describe('templated Markdown outputs never contain literal backslash-backtick bytes', () => {
  it('aipm init: README.md emits real backtick bytes (issue #93 AC1/AC2)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'templated-md-init-test-'));
    try {
      const repoDir = path.join(tmpDir, 'my-repo');
      await runInit(repoDir);

      const mdFiles = collectMarkdownFiles(repoDir);
      expect(mdFiles).toContain('README.md');
      for (const rel of mdFiles) {
        expectNoLiteralBackslashBacktick(path.join(repoDir, rel));
      }

      // Spot-check: the README's fenced code blocks and inline code spans use real backticks.
      const readme = fs.readFileSync(path.join(repoDir, 'README.md'), 'utf-8');
      expect(readme).toContain('```sh');
      expect(readme).toContain('`aipm scaffold`');
      expect(readme).not.toContain('\\`');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('aipm scaffold: every target Markdown output (incl. POWER.md) emits real backtick bytes (issue #93 AC1/AC2)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'templated-md-scaffold-test-'));
    try {
      const pluginsDir = path.join(tmpDir, 'plugins');
      await runScaffold('my-plugin', pluginsDir, { targets: [...TARGET_IDS] });

      const pluginDir = path.join(pluginsDir, 'my-plugin');
      const mdFiles = collectMarkdownFiles(pluginDir);
      // Every target that scaffolds Markdown is exercised, including Kiro's POWER.md.
      expect(mdFiles).toContain('POWER.md');
      expect(mdFiles).toContain('README.md');
      expect(mdFiles.length).toBeGreaterThan(0);
      for (const rel of mdFiles) {
        expectNoLiteralBackslashBacktick(path.join(pluginDir, rel));
      }

      // Spot-check: POWER.md's "Related Files" bullet renders a real backtick-quoted code span.
      const powerMd = fs.readFileSync(path.join(pluginDir, 'POWER.md'), 'utf-8');
      expect(powerMd).toContain('`steering/`');
      expect(powerMd).not.toContain('\\`');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("POWER.md's steering/ reference no longer reads as an existing sibling file (issue #93 AC3)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'templated-md-power-steering-test-'));
    try {
      const pluginsDir = path.join(tmpDir, 'plugins');
      await runScaffold('my-plugin', pluginsDir, { targets: ['kiro'] });

      const pluginDir = path.join(pluginsDir, 'my-plugin');
      const powerMd = fs.readFileSync(path.join(pluginDir, 'POWER.md'), 'utf-8');

      // A freshly-scaffolded plugin has no `steering/` directory yet — Kiro's only contributed
      // file is POWER.md. The "Related Files" bullet must not present `steering/` as an existing
      // related file; it should be clearly marked optional/hand-authored.
      expect(fs.existsSync(path.join(pluginDir, 'steering'))).toBe(false);
      expect(powerMd).toMatch(/`steering\/`\s*\(optional/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
