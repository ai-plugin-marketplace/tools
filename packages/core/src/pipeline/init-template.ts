/**
 * Embedded file contents for the `aipm init` scaffolder (§3.2 template repo contents).
 *
 * `aipm init` generates a **thin consumer repo** — a repository that depends on
 * `@ai-plugin-marketplace/cli` and holds plugin *sources* only, never toolkit source (§11). All of
 * that repo's seed files are authored here as deterministic string templates so the output is a
 * pure function of the repo name and the toolkit version (no clocks, no environment reads).
 *
 * Why string constants instead of a packaged asset directory: bundling a `template/` fixture would
 * require a `package.json#files`/asset-directory entry. Inlining the contents keeps the generated
 * tree reproducible and lets `tsc` typecheck the literals.
 *
 * @see docs/specs/architecture.md §3.2 (template repo contents)
 * @see docs/specs/architecture.md §11 (template→toolkit dependency contract)
 * @see docs/specs/architecture.md §10.5 (freshness check the CI workflow runs)
 */

const json = String.raw;
const md = String.raw;
const yaml = String.raw;

/** A relative path plus the file's full contents, ready to write under the target directory. */
export interface InitFile {
  /** POSIX-style path relative to the target directory. */
  path: string;
  /** Full file contents, including a trailing newline. */
  content: string;
}

/**
 * The `package.json` for a generated consumer repo.
 *
 * - `private: true` — a plugin repo is never published to npm; only its plugins ship to registries.
 * - `type: 'module'` — the toolkit is ESM-only (§8.1), and `aipm.config.ts` files are ESM.
 * - `scripts` call `aipm` directly (it is on PATH via the dev dependency's bin).
 * - The `@ai-plugin-marketplace/cli` dev dependency is pinned to `^<toolkitVersion>` so authors
 *   upgrade the whole toolkit in lockstep via `pnpm up` (§9.1 lockstep release, §11 contract).
 *
 * Emitted as 2-space JSON with a trailing newline to match the repo's formatting conventions.
 */
function renderPackageJson(name: string, toolkitVersion: string): string {
  const pkg = {
    name,
    private: true,
    type: 'module',
    scripts: {
      build: 'aipm build',
      check: 'aipm validate',
      scaffold: 'aipm scaffold',
    },
    devDependencies: {
      // cli provides the `aipm` binary; core provides `defineConfig` for each
      // plugin's `aipm.config.ts` import (§6.1). Both pinned to the same toolkit
      // version and upgraded together via `pnpm up`.
      '@ai-plugin-marketplace/cli': `^${toolkitVersion}`,
      '@ai-plugin-marketplace/core': `^${toolkitVersion}`,
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Empty marketplace registry: `{ "plugins": [] }`, 2-space JSON + trailing newline (§4.4). */
function renderEmptyMarketplace(): string {
  return json`{
  "plugins": []
}
`;
}

/** README pointing authors at the upgrade-via-`pnpm up` workflow (§11). */
function renderReadme(name: string): string {
  return md`# ${name}

An AI plugin marketplace repository, authored with
[\`@ai-plugin-marketplace\`](https://www.npmjs.com/package/@ai-plugin-marketplace/cli).

## Getting started

\`\`\`sh
pnpm install
aipm scaffold <plugin-name>
\`\`\`

\`aipm scaffold\` adds a new plugin under \`plugins/\`. Run \`aipm build\` to generate
artifacts and \`aipm validate\` to check them.

## Upgrading the toolkit

This repository holds plugin sources only — the build, validation, and scaffolding
logic lives in \`@ai-plugin-marketplace/cli\`. Upgrade it (and every capability it
provides) with:

\`\`\`sh
pnpm up @ai-plugin-marketplace/cli
\`\`\`
`;
}

/**
 * CI workflow that runs `aipm build` then `aipm validate` on push/PR.
 *
 * Running `build` before `validate` enforces the freshness check (§10.5): `validate` compares the
 * committed generated artifacts against what a fresh `build` would produce and fails on drift. In
 * CI (`CI=true`, set by GitHub Actions) freshness findings are hard (§10.2).
 */
function renderCiWorkflow(): string {
  return yaml`name: CI

on:
  push:
  pull_request:

jobs:
  build-and-validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec aipm build
      - run: pnpm exec aipm validate
`;
}

/** `.gitignore` for a consumer repo: dependencies, build intermediates, OS/local cruft. */
function renderGitignore(): string {
  return `node_modules/
.DS_Store
*.local.*
*.tsbuildinfo
`;
}

/**
 * Build the complete, deterministic seed file set for a consumer repo named `name`, pinning the
 * `@ai-plugin-marketplace/cli` dev dependency to `^${toolkitVersion}`.
 *
 * The set mirrors §3.2: `package.json`, `.gitignore`, `README.md`, both repo-root marketplace
 * registries, an empty `plugins/` (seeded with `.gitkeep` so the directory is tracked), and the
 * CI workflow. Output is a pure function of the two inputs — stable ordering, no timestamps.
 */
export function buildInitFiles(name: string, toolkitVersion: string): InitFile[] {
  return [
    { path: 'package.json', content: renderPackageJson(name, toolkitVersion) },
    { path: '.gitignore', content: renderGitignore() },
    { path: 'README.md', content: renderReadme(name) },
    { path: '.claude-plugin/marketplace.json', content: renderEmptyMarketplace() },
    { path: '.cursor-plugin/marketplace.json', content: renderEmptyMarketplace() },
    { path: 'plugins/.gitkeep', content: '' },
    { path: '.github/workflows/ci.yml', content: renderCiWorkflow() },
  ];
}
