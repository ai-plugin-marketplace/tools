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
  buildWithOutcome,
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

| Export             | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `init`             | Scaffold a new plugin repo at a given directory                    |
| `build`            | Build artifacts for a plugin or all plugins under a repo root      |
| `buildWithOutcome` | Build artifacts and return post-build validation findings          |
| `validate`         | Inspect on-disk state and return `ValidationResult` (read-only)    |
| `scaffold`         | Create a new plugin directory from templates                       |
| `migrate`          | Apply schema migrations (no-op in v0.1.0; real in future releases) |
| `checkSupport`     | Report missing artifacts and expansion suggestions for a plugin    |
| `addTarget`        | Scaffold skeleton files for a new target in an existing plugin     |
| `listTargets`      | Return the `TargetId` values this toolkit version recognises       |

`build()` returns a `BuildResult[]` and skips freshness checks during post-build validation.
Use `buildWithOutcome()` with the same arguments to get `{ results, validation }`. It runs the
same build and then runs standalone validation, including freshness and published-surface
diagnostics. Filesystem failures observed during the build or validation appear as hard
`BuildFreshnessIoFinding` diagnostics with code `freshness-io`. Any such finding makes
`validation.passed` false. With `failFast: true`, hard structural findings and filesystem failures
reject the build. Artifact drift stays in the outcome and is hard in CI and soft locally.
Fatal generation errors reject with any findings already established. Validation assumes source
inputs stay unchanged by other processes during the call.

### Key types

`TargetId`, `BuildOptions`, `BuildOutcome`, `BuildFreshnessIoFinding`, `BuildResult`, `GeneratedFile`, `ValidateOptions`,
`ValidationResult`, `Finding`, `FindingCode`, `ScaffoldOptions`, `InitOptions`,
`MigrateOptions`, `MigrateResult`, `SupportReport`.

## Links

- [Architecture spec](../../docs/specs/architecture.md) (§8.1 for the full public-API contract)
- [Repository](https://github.com/ai-plugin-marketplace/tools)

## License

MIT
