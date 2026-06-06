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

/**
 * pnpm version pinned in the generated `package.json#packageManager`. The CI workflow reads the
 * pnpm version from this field (it runs `pnpm/action-setup` without a hard-coded version), so the
 * two stay in sync. Bumped deliberately when the recommended pnpm baseline moves.
 */
const PACKAGE_MANAGER = 'pnpm@10.30.3';

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
 * - `packageManager` pins pnpm; the CI workflow reads the pnpm version from here.
 * - `scripts` call `aipm` directly (it is on PATH via the dev dependency's bin).
 * - `cli` provides the `aipm` binary; `core` provides `defineConfig`/`defineWorkspace` for each
 *   plugin's `aipm.config.ts` (§6.1). They ship independently and may differ (`cli 0.1.1` ships
 *   with `core 0.2.0`), so each is pinned to a caret of its own version; authors upgrade both via
 *   `pnpm up` (§11 contract).
 *
 * Emitted as 2-space JSON with a trailing newline to match the repo's formatting conventions.
 */
function renderPackageJson(name: string, cliVersion: string, coreVersion: string): string {
  const pkg = {
    name,
    private: true,
    type: 'module',
    packageManager: PACKAGE_MANAGER,
    scripts: {
      build: 'aipm build',
      check: 'aipm validate',
      scaffold: 'aipm scaffold',
    },
    devDependencies: {
      '@ai-plugin-marketplace/cli': `^${cliVersion}`,
      '@ai-plugin-marketplace/core': `^${coreVersion}`,
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
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  CI:
    runs-on: ubuntu-latest
    env:
      CI: "true"
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        # version is read from package.json#packageManager — do not duplicate here

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build plugins
        run: pnpm exec aipm build

      - name: Verify the tree is clean after build (freshness)
        run: |
          if [ -n "$(git status --porcelain)" ]; then
            echo "::error::Working tree is dirty after 'aipm build'. Run 'aipm build' locally and commit the regenerated artifacts."
            git status --porcelain
            git --no-pager diff
            exit 1
          fi

      - name: Validate plugins
        run: pnpm exec aipm validate
`;
}

/**
 * `.gitignore` for a consumer repo. Comprehensive baseline covering dependencies, build
 * intermediates, logs, test coverage, caches, environment/secret files, scratch artifacts, and
 * OS/local cruft. Notably ignores `.env*` so a freshly scaffolded repo cannot accidentally commit
 * secrets.
 *
 * Deliberately does **not** ignore `dist/`: toolkit build output (per-plugin `dist/` bundles and
 * `hooks/*.json`) is committed for consumer install and the freshness check — see the build
 * contract and `.gitattributes`.
 *
 * This is **seed-only**: `aipm init` writes it, but it is intentionally absent from
 * {@link buildManagedScaffoldFiles} so `aipm init --refresh` never clobbers or perpetually flags
 * the user's own additions (`.gitignore` is something users legitimately extend).
 */
function renderGitignore(): string {
  return `# Dependencies
node_modules/

# Build intermediates
*.tsbuildinfo

# Logs
*.log
logs/

# Test coverage
coverage/
*.lcov

# Caches
.cache/
.eslintcache
.npm/

# Environment / secrets
.env
.env.*
!.env.example

# Scratch & manual-test artifacts
scratch/

# OS / editor cruft
.DS_Store

# Local overrides
*.local.*
`;
}

/**
 * Toolkit-owned **scaffold** files that `aipm init --refresh` keeps in sync with the installed
 * tooling: the CI workflow. It is a pure tooling recipe — its content is independent of the repo
 * name and the pinned toolkit version, so refresh can re-render it with no inputs and compare
 * byte-for-byte. (Files with repo identity or user content — `package.json`, `aipm.workspace.ts`,
 * `README.md`, plugins, `aipm build` output — are deliberately NOT here. `.gitignore` is seeded by
 * `init` but NOT managed, since users extend it freely.)
 *
 * Output is deterministic and stably ordered.
 */
export function buildManagedScaffoldFiles(): InitFile[] {
  return [{ path: '.github/workflows/ci.yml', content: renderCiWorkflow() }];
}

/**
 * Build the complete, deterministic seed file set for a consumer repo named `name`, pinning the
 * `cli`/`core` dev dependencies to carets of `cliVersion`/`coreVersion` respectively.
 *
 * The set mirrors §3.2: `package.json`, the seed-only `.gitignore`, the
 * {@link buildManagedScaffoldFiles managed scaffold files} (CI workflow), `README.md`, both
 * repo-root marketplace registries, and an empty `plugins/` (seeded with `.gitkeep` so the
 * directory is tracked). Output is a pure function of the inputs — stable ordering, no timestamps.
 */
export function buildInitFiles(name: string, cliVersion: string, coreVersion: string): InitFile[] {
  return [
    { path: 'package.json', content: renderPackageJson(name, cliVersion, coreVersion) },
    { path: '.gitignore', content: renderGitignore() },
    { path: 'README.md', content: renderReadme(name) },
    { path: '.claude-plugin/marketplace.json', content: renderEmptyMarketplace() },
    { path: '.cursor-plugin/marketplace.json', content: renderEmptyMarketplace() },
    { path: 'plugins/.gitkeep', content: '' },
    ...buildManagedScaffoldFiles(),
  ];
}
