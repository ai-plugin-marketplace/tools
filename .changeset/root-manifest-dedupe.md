---
'@ai-plugin-marketplace/core': patch
---

Fix a false `freshness` finding on the generated-root sidecar manifest.

When a single plugin declares both `gemini` and `kiro`, a file shared by both bundles (e.g. `skills/<name>/SKILL.md`) is emitted to the repo root once, but the validate-side freshness oracle collects it once per emitting host. `serializeRootManifest` sorted but did not dedupe, so the manifest build wrote (from a deduped set) never matched the oracle's (duplicated) expectation — the sidecar read as perpetually stale right after a successful build. `serializeRootManifest` now dedupes as well as sorts, so the bytes are canonical regardless of caller. Surfaced by dogfooding the toolchain on its own repo.
