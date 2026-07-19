---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

Make `aipm add-target` preserve-or-warn instead of refusing an already-materialized target and
generating a schema-invalid skeleton on retry.

Previously, `add-target` threw `Refusing to overwrite` when any file the target would write
already existed — including the common case where the target is already fully scaffolded — and
the printed remedy ("remove the file, then re-run") regenerated a placeholder with a blanked
`description`, which is schema-invalid for targets whose manifest requires a non-empty
`description` (e.g. Vercel's `SKILL.md`), immediately failing `aipm build`.

- An already-materialized target (every file it would write already exists) is now a friendly
  no-op: `addTarget()` resolves with `{ status: 'already-present', written: [], preserved: [...] }`
  and the CLI prints `'<target>' is already present in <plugin>; nothing to do.` instead of
  throwing.
- Existing files are never overwritten. For a multi-file target with a partial conflict, the
  existing file(s) are preserved untouched and only the missing file(s) are written
  (`status: 'partially-added'`); the CLI reports which files were preserved so the author can
  review them by hand.
- `addTarget()`'s public return type changes from `Promise<void>` to
  `Promise<AddTargetOutcome>` (new exported type: `{ target, status, written, preserved }`).
- Placeholder fields a schema requires to be non-empty (Vercel's `SKILL.md` `description`) are now
  emitted as non-empty placeholder prose instead of a blank string, so add-target's own output
  always passes `aipm build`/`aipm validate`.
