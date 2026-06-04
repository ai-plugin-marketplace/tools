/**
 * Tests for `runInit`: scaffold a thin consumer repo (§3.2) into a real temp directory and assert
 * the full seed file set, the pinned `cli`/`core` dev dependencies (§11 contract), the seeded
 * `.aipm/scaffold.json` refresh sidecar, and that the generated repo passes `runValidate` out of
 * the box (an empty `plugins/` is valid). Uses real temp directories (`fs.mkdtempSync`), matching
 * `scaffold.test.ts`.
 *
 * `cli` and `core` ship independently and may differ, so `runInit` pins each to a caret of its own
 * version: `core` from core's own `package.json` (read here the same way), `cli` from
 * `opts.cliVersion` (falling back to core's version when omitted).
 *
 * @see docs/specs/architecture.md §3.2 (template repo contents)
 * @see docs/specs/architecture.md §11 (template→toolkit dependency contract)
 * @see docs/specs/scaffold-refresh-and-upgrade.md (`aipm init --refresh`)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit } from './init.js';
import { runValidate } from './validate.js';

/** core's own version — the value `runInit` pins the cli dev dependency to (`^<version>`). */
const CORE_VERSION = (
  JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
      'utf-8',
    ),
  ) as { version: string }
).version;

interface GeneratedPackageJson {
  name?: string;
  private?: boolean;
  type?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface MarketplaceShape {
  plugins?: unknown[];
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-init-test-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

/** Read a file under `repoDir`; returns '' when absent. */
function read(repoDir: string, rel: string): string {
  const full = path.join(repoDir, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : '';
}

/** Parse the generated `package.json` under `repoDir`. */
function readPackageJson(repoDir: string): GeneratedPackageJson {
  return JSON.parse(read(repoDir, 'package.json')) as GeneratedPackageJson;
}

/** Parse a marketplace registry file under `repoDir`. */
function readMarketplace(repoDir: string, rel: string): MarketplaceShape {
  return JSON.parse(read(repoDir, rel)) as MarketplaceShape;
}

describe('runInit', () => {
  it('writes the full §3.2 seed file set', async () => {
    const repoDir = path.join(tmpDir, 'my-repo');
    await runInit(repoDir);

    // §3.2: every seed file is present, plus the refresh sidecar.
    for (const rel of [
      'package.json',
      '.gitignore',
      'README.md',
      '.claude-plugin/marketplace.json',
      '.cursor-plugin/marketplace.json',
      'plugins/.gitkeep',
      '.github/workflows/ci.yml',
      '.aipm/scaffold.json',
    ]) {
      expect(fs.existsSync(path.join(repoDir, rel)), `${rel} should exist`).toBe(true);
    }
  });

  it('derives the repo name from the target directory basename', async () => {
    const repoDir = path.join(tmpDir, 'derived-name');
    await runInit(repoDir);
    const pkg = readPackageJson(repoDir);
    expect(pkg.name).toBe('derived-name');
  });

  it('honors an explicit name override', async () => {
    const repoDir = path.join(tmpDir, 'on-disk-dir');
    await runInit(repoDir, { name: 'explicit-name' });
    const pkg = readPackageJson(repoDir);
    expect(pkg.name).toBe('explicit-name');
  });

  it('defaults the cli pin to core’s version when no cliVersion is given (§11)', async () => {
    const repoDir = path.join(tmpDir, 'pinned');
    await runInit(repoDir);
    const pkg = readPackageJson(repoDir);
    expect(pkg.devDependencies?.['@ai-plugin-marketplace/cli']).toBe(`^${CORE_VERSION}`);
    expect(pkg.devDependencies?.['@ai-plugin-marketplace/core']).toBe(`^${CORE_VERSION}`);
  });

  it('pins cli and core independently when cli and core versions skew', async () => {
    // Regression: init must NOT pin cli to core's version. cli and core ship independently
    // (e.g. cli 0.1.1 ships with core 0.2.0); pinning both to core's version yields an
    // uninstallable `@ai-plugin-marketplace/cli` range.
    const repoDir = path.join(tmpDir, 'skewed');
    await runInit(repoDir, { cliVersion: '9.9.9' });
    const pkg = readPackageJson(repoDir);
    expect(pkg.devDependencies?.['@ai-plugin-marketplace/cli']).toBe('^9.9.9');
    expect(pkg.devDependencies?.['@ai-plugin-marketplace/core']).toBe(`^${CORE_VERSION}`);
  });

  it('pins pnpm via packageManager so CI resolves a pnpm version (§3.2)', async () => {
    const repoDir = path.join(tmpDir, 'pkg-mgr');
    await runInit(repoDir);
    const pkg = readPackageJson(repoDir);
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('seeds .aipm/scaffold.json recording the managed scaffold files', async () => {
    const repoDir = path.join(tmpDir, 'sidecar');
    await runInit(repoDir);
    const sidecar = JSON.parse(read(repoDir, '.aipm/scaffold.json')) as {
      version?: number;
      files?: { path: string; hash: string }[];
    };
    expect(sidecar.version).toBe(1);
    const paths = (sidecar.files ?? []).map((f) => f.path).sort();
    expect(paths).toEqual(['.github/workflows/ci.yml', '.gitignore']);
    for (const f of sidecar.files ?? []) {
      expect(f.hash, `${f.path} hash`).toMatch(/^sha256-[0-9a-f]{64}$/);
    }
  });

  it('emits a private, ESM package.json with the aipm scripts (§3.2)', async () => {
    const repoDir = path.join(tmpDir, 'pkg-shape');
    await runInit(repoDir);
    const pkg = readPackageJson(repoDir);
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.scripts).toEqual({
      build: 'aipm build',
      check: 'aipm validate',
      scaffold: 'aipm scaffold',
    });
  });

  it('writes both repo-root marketplace registries as { plugins: [] } (§4.4)', async () => {
    const repoDir = path.join(tmpDir, 'registries');
    await runInit(repoDir);
    for (const rel of ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json']) {
      const registry = readMarketplace(repoDir, rel);
      expect(registry).toEqual({ plugins: [] });
    }
  });

  it('writes a CI workflow that runs `aipm build` then `aipm validate` (§10.5)', async () => {
    const repoDir = path.join(tmpDir, 'ci');
    await runInit(repoDir);
    const ci = read(repoDir, '.github/workflows/ci.yml');
    expect(ci).toContain('aipm build');
    expect(ci).toContain('aipm validate');
  });

  it('produces 2-space JSON with trailing newlines', async () => {
    const repoDir = path.join(tmpDir, 'formatting');
    await runInit(repoDir);
    const pkgRaw = read(repoDir, 'package.json');
    expect(pkgRaw.endsWith('\n')).toBe(true);
    expect(pkgRaw).toContain('\n  "private": true');
    const registryRaw = read(repoDir, '.claude-plugin/marketplace.json');
    expect(registryRaw.endsWith('\n')).toBe(true);
  });

  it('scaffolds into an existing empty directory', async () => {
    const repoDir = path.join(tmpDir, 'pre-created-empty');
    fs.mkdirSync(repoDir);
    await runInit(repoDir);
    expect(fs.existsSync(path.join(repoDir, 'package.json'))).toBe(true);
  });

  it('produces a repo that passes runValidate (empty plugins dir is valid)', async () => {
    const repoDir = path.join(tmpDir, 'valid-repo');
    await runInit(repoDir);
    const result = await runValidate(repoDir);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('is deterministic: two runs into separate dirs produce identical files', async () => {
    const a = path.join(tmpDir, 'det-a');
    const b = path.join(tmpDir, 'det-b');
    // Same name so the only potential difference would be non-determinism (e.g. a timestamp).
    await runInit(a, { name: 'same-name' });
    await runInit(b, { name: 'same-name' });
    for (const rel of ['package.json', 'README.md', '.github/workflows/ci.yml']) {
      expect(read(a, rel)).toBe(read(b, rel));
    }
  });

  it('refuses to clobber a non-empty directory', async () => {
    const repoDir = path.join(tmpDir, 'non-empty');
    fs.mkdirSync(repoDir);
    fs.writeFileSync(path.join(repoDir, 'existing.txt'), 'keep me', 'utf-8');
    await expect(runInit(repoDir)).rejects.toThrow(/already exists and is not empty/);
    // The pre-existing file is untouched and no package.json was written.
    expect(read(repoDir, 'existing.txt')).toBe('keep me');
    expect(fs.existsSync(path.join(repoDir, 'package.json'))).toBe(false);
  });

  it('refuses when the target path exists as a non-directory', async () => {
    const filePath = path.join(tmpDir, 'a-file');
    fs.writeFileSync(filePath, 'not a dir', 'utf-8');
    await expect(runInit(filePath)).rejects.toThrow(/not empty|not a directory|already exists/);
  });
});
