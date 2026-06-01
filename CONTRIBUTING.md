# Contributing to `@ai-plugin-marketplace/tools`

## Prerequisites

- **Node.js ≥ 20** and **pnpm ≥ 10**
- A local checkout of this repo

## Setup

```bash
pnpm install   # installs deps and sets up the pre-commit hook via husky
```

## Development workflow

```bash
pnpm run build        # tsc + API Extractor rollup (Nx-cached)
pnpm run check        # full gate: typecheck + lint + knip + syncpack + format + api-report + test
pnpm run test         # run all tests (Nx-cached, per-package Vitest)
pnpm run fix:format   # auto-format everything
pnpm run fix:lint-ts  # auto-fix lint across packages
```

A **pre-commit hook** (husky + lint-staged) auto-formats staged files and runs ESLint `--fix`
before each commit. If the hook fails, fix the reported issues then re-stage and retry.

## Adding a new target

1. Create `packages/core/src/targets/<id>/` with `schemas.ts`, `transform.ts`, `validate.ts`,
   `scaffold.ts`, and (if it produces a standalone bundle) `bundle.ts`.
2. Add `<id>` to `TARGET_IDS` in `packages/core/src/pipeline/types.ts` and `TargetId` union.
3. Wire into the pipeline orchestrators (`build.ts`, `validate.ts`, `scaffold.ts`).
4. Add the target's cross-import isolation rule to `eslint.config.mjs`.
5. Run `pnpm run check` — green is the exit criterion.

See [`docs/specs/architecture.md`](./docs/specs/architecture.md) §12.4 and §12.5 for the internal
module interface and forward-compatibility seam.

## Releasing

See [`RELEASING.md`](./RELEASING.md).
