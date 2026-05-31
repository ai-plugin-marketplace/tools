# @ai-plugin-marketplace/core

Build pipeline, validation, scaffolding, and `defineConfig` — the programmatic API behind the
`aipm` CLI.

> Most users should install [`@ai-plugin-marketplace/cli`](../cli) instead. Use this package
> directly only when you need to call the build/validate operations from your own scripts.

## Install

```sh
pnpm add -D @ai-plugin-marketplace/core
```

## Public API

All exports are available from the root import path — there are no public subpaths.

```ts
import {
  defineConfig,
  build,
  validate,
  scaffold,
  init,
  migrate,
  checkSupport,
  addTarget,
  listTargets,
} from '@ai-plugin-marketplace/core';
```

### Config

| Export            | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `defineConfig`    | Validates and brands an `AipmConfigInput`; use in every `aipm.config.ts` |
| `AipmConfigInput` | Input type: `{ version: string; targets: TargetId[] }`                   |
| `AipmConfig`      | Branded output type returned by `defineConfig`                           |

### Operations

| Export         | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `init`         | Scaffold a new plugin repo at a given directory                    |
| `build`        | Build artifacts for a plugin or all plugins under a repo root      |
| `validate`     | Inspect on-disk state and return `ValidationResult` (read-only)    |
| `scaffold`     | Create a new plugin directory from templates                       |
| `migrate`      | Apply schema migrations (no-op in v0.1.0; real in future releases) |
| `checkSupport` | Report missing artifacts and expansion suggestions for a plugin    |
| `addTarget`    | Scaffold skeleton files for a new target in an existing plugin     |
| `listTargets`  | Return the `TargetId` values this toolkit version recognises       |

### Key types

`TargetId`, `BuildOptions`, `BuildResult`, `GeneratedFile`, `ValidateOptions`,
`ValidationResult`, `Finding`, `FindingCode`, `ScaffoldOptions`, `InitOptions`,
`MigrateOptions`, `MigrateResult`, `SupportReport`.

## Links

- [Architecture spec](../../docs/specs/architecture.md) (§8.1 for the full public-API contract)
- [Repository](https://github.com/ai-plugin-marketplace/tools)

## License

MIT
