# ai-plugin-marketplace/tools

Monorepo publishing the `@ai-plugin-marketplace/*` toolkit consumed by the [`template`](https://github.com/ai-plugin-marketplace/template) repository.

## Packages

| Package                                          | Purpose                                                    |
| ------------------------------------------------ | ---------------------------------------------------------- |
| [`@ai-plugin-marketplace/core`](./packages/core) | Build pipeline, validation, scaffolding. Programmatic API. |
| [`@ai-plugin-marketplace/cli`](./packages/cli)   | `aipm` binary. Thin wrapper around `core`.                 |

Plugin authors depend only on `@ai-plugin-marketplace/cli`. The consumer flow:

```sh
# Generate a new plugins repo from the CLI (one-time)
aipm init my-plugins
cd my-plugins

# Add a plugin
aipm scaffold my-plugin

# Upgrade the toolkit — no plugin source changes required for minor/patch releases
pnpm up @ai-plugin-marketplace/cli
```

## Embedding a marketplace in an existing repo

The flow above creates a **dedicated** marketplace repo. You can also turn a repo whose primary purpose is shipping _software_ (a CLI, a library) into a marketplace for the agent plugins that drive it, so the software and its skills ship together. Add an optional `aipm.repo.ts` to relocate the plugins/dist roots off any names your repo already uses:

```ts
// aipm.repo.ts (repo root)
import { defineRepoConfig } from '@ai-plugin-marketplace/core';

export default defineRepoConfig({ pluginsRoot: 'agent-plugins', distDir: 'agent-plugins/dist' });
```

`aipm scaffold` / `build` / `validate` then operate against the relocated root. Full step-by-step: [**Embedding a marketplace in an existing software repo**](./docs/guides/embedded-marketplace.md).

## Architecture

The definitive architecture specification lives at [`docs/specs/architecture.md`](./docs/specs/architecture.md). Read it before making non-trivial changes to package boundaries, the public API, the per-target module structure, or the versioning contract.

## Local development

```bash
pnpm install
pnpm run check    # typecheck + lint + knip + syncpack + format + api-report + test (per-package, Nx-cached)
pnpm run build    # tsc + API Extractor rollup
```

## Releasing

Versioned and published with Changesets. The packages are ready for the `0.1.0` release; the only
missing piece is npm credentials. See [`RELEASING.md`](./RELEASING.md).

## Status

`0.1.0` ready to publish (pending npm credentials). See
[`docs/specs/architecture.md`](./docs/specs/architecture.md) for the architecture and §13 for the
phased plan.

## License

MIT
