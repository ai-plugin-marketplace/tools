# ai-plugin-marketplace/tools

Monorepo publishing the `@ai-plugin-marketplace/*` toolkit consumed by the [`template`](https://github.com/ai-plugin-marketplace/template) repository.

## Packages

| Package                                          | Purpose                                                    |
| ------------------------------------------------ | ---------------------------------------------------------- |
| [`@ai-plugin-marketplace/core`](./packages/core) | Build pipeline, validation, scaffolding. Programmatic API. |
| [`@ai-plugin-marketplace/cli`](./packages/cli)   | `aipm` binary. Thin wrapper around `core`.                 |

## Architecture

The definitive architecture specification lives at [`docs/specs/architecture.md`](./docs/specs/architecture.md). Read it before making non-trivial changes to package boundaries, the public API, the per-target module structure, or the versioning contract.

## Local development

```bash
pnpm install
pnpm run check    # typecheck + lint + format:check + test
```

## Status

v0.1.0-alpha — bootstrap in progress. See [`docs/specs/architecture.md`](./docs/specs/architecture.md) §13 for the phased plan.

## License

MIT
