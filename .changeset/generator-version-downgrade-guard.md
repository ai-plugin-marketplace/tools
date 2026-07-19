---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

Guard `aipm build` against a stale installed toolkit silently reverting generated artifacts.

Every sentinel-carrying generated artifact is now stamped with the `@ai-plugin-marketplace/core`
version that produced it (`_generated.version` in JSON outputs, a `# version:` line in
inline/sidecar outputs). Before writing anything, `aipm build` compares the installed core version
against the version stamped into existing committed artifacts: if the installed toolkit is **older**
(by semver precedence), the build refuses with a non-zero exit and a message naming both versions
and suggesting `pnpm install`. This closes the failure mode where a checkout with a stale
`node_modules` regenerates committed outputs with an older generator and silently reverts a shipped
fix. Equal-or-newer installs, first-time/unstamped trees, and same-version rebuilds proceed as
before and (re)stamp with the installed version.

- New `BuildOptions.forceDowngrade` and the `aipm build --force-downgrade` flag override the guard.
- The freshness check ignores the version stamp, so a version bump alone no longer marks committed
  artifacts stale.
