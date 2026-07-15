# ai-plugin-marketplace/tools

Monorepo publishing the `@ai-plugin-marketplace/*` toolkit (consumed by the [`template`](https://github.com/ai-plugin-marketplace/template) repository) — and, dogfooding that toolkit, **itself an AI plugin marketplace**.

## Install the agent plugin

This repo ships one plugin, **`marketplace-authoring`**, that equips your coding agent to turn any software repo into an AI plugin marketplace with this toolkit. Install it into your assistant through its native mechanism:

| Assistant       | Install                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| **Claude Code** | `/plugin marketplace add ai-plugin-marketplace/tools`                                      |
| **Cursor**      | Dashboard → Settings → Plugins → Import → `https://github.com/ai-plugin-marketplace/tools` |
| **Codex**       | `codex plugin marketplace add ai-plugin-marketplace/tools`                                 |
| **Gemini CLI**  | `gemini extensions install https://github.com/ai-plugin-marketplace/tools`                 |
| **Kiro**        | Powers panel → "Add power from GitHub" → repo URL                                          |

Or, cross-tool via the universal [`plugins`](https://github.com/vercel-labs/plugins) CLI (it installs the **native** plugin where the tool supports it):

```sh
npx plugins add ai-plugin-marketplace/tools
```

The toolkit also emits a vendor-neutral **[Open Plugins](https://open-plugins.com)** target: a repo built with `aipm` that declares `open-plugins` publishes a repo-root `marketplace.json` (Open Plugins lookup position 1) alongside the native `.plugin/plugin.json` manifests, so it is installable by **any Open-Plugins-conformant host** rather than only the hosts listed above.

Then ask your agent to _"add AI plugin marketplace support to this repo"_ and the skill walks it through the rest.

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

## Authoring hook handlers

Any plugin that authors `hooks/claude.yaml` also gets a generated **[`hooks/payload-adapter`](./docs/specs/payload-adapter.md)**: a static `sh` + `jq` filter your handler pipes its stdin through to read one canonical payload shape regardless of whether Claude Code or Codex invoked it, instead of re-deriving per-harness field names by hand. See [**Authoring hook handlers with the payload adapter**](./docs/guides/hook-handler-authoring.md) for the copy-runnable patterns, the per-field assertability table, and a worked permission-layer example.

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
