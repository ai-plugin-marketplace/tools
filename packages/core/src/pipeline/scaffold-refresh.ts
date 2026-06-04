/**
 * `aipm init --refresh` — keep a marketplace repo's **toolkit-owned scaffold files** (the CI
 * workflow and `.gitignore`) in sync with the installed tooling, and serve as the upgrade path for
 * any marketplace repo after `pnpm up @ai-plugin-marketplace/*`.
 *
 * Safety rests on a content-hash sidecar at `.aipm/scaffold.json` (mirroring the root-emission
 * sidecar `.aipm/generated-root.json`): it records a hash of the exact content the toolkit last
 * wrote each managed file. Refresh updates a file only when it is still pristine (matches the
 * recorded hash) or missing; a file the user has edited surfaces as a reported conflict and is left
 * untouched unless `--force` is given. A repo with no sidecar entry bootstraps: an already-in-sync
 * file is adopted silently, a diverged one is a conflict to review.
 *
 * The managed set is deliberately narrow — only the pure tooling-recipe files (see
 * {@link buildManagedScaffoldFiles}). `package.json` (deps are `pnpm up`'s job), `aipm.workspace.ts`
 * (repo identity), `README.md` (authored), plugins, and `aipm build` output are never touched.
 *
 * @see docs/specs/scaffold-refresh-and-upgrade.md
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildManagedScaffoldFiles } from './init-template.js';
import type { RefreshOptions, RefreshOutcome } from './types.js';

/** Sidecar location relative to the repo root. */
const SIDECAR_REL = ['.aipm', 'scaffold.json'] as const;
/** Schema version of the sidecar payload. */
const SIDECAR_VERSION = 1;

/** A recorded `{ path, hash }` pair: the hash of the content the toolkit last wrote at `path`. */
interface SidecarEntry {
  path: string;
  hash: string;
}

/** Absolute path of the scaffold sidecar under `repoRoot`. */
function sidecarPath(repoRoot: string): string {
  return path.join(repoRoot, ...SIDECAR_REL);
}

/** Content hash recorded in the sidecar. `sha256-`-prefixed hex over the UTF-8 bytes. */
export function hashScaffoldContent(content: string): string {
  return `sha256-${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

/**
 * Serialize a sidecar payload: `{ version, files }` with `files` sorted by path for determinism,
 * 2-space JSON + trailing newline (matching the repo's other generated JSON).
 */
export function serializeScaffoldSidecar(entries: readonly SidecarEntry[]): string {
  const files = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  return `${JSON.stringify({ version: SIDECAR_VERSION, files }, null, 2)}\n`;
}

/** Read the prior sidecar into a `path → hash` map. Missing or malformed sidecar → empty map. */
function readSidecar(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  const abs = sidecarPath(repoRoot);
  if (!fs.existsSync(abs)) return map;
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8')) as { files?: unknown };
    if (Array.isArray(parsed.files)) {
      for (const raw of parsed.files) {
        const entry = raw as Partial<SidecarEntry>;
        if (typeof entry.path === 'string' && typeof entry.hash === 'string') {
          map.set(entry.path, entry.hash);
        }
      }
    }
  } catch {
    // A malformed sidecar is treated as absent: every managed file becomes "untracked" and must
    // either already match the current render (adopted) or be resolved via --force.
  }
  return map;
}

/** Inputs to the pure per-file refresh decision. */
export interface ManagedFileDecisionInput {
  /** Canonical content the toolkit would render for this file. */
  render: string;
  /** Current on-disk content, or `null` when the file is missing. */
  current: string | null;
  /** Hash recorded in the sidecar for this file, or `null` when untracked. */
  recordedHash: string | null;
  /** Whether `--force` was given. */
  force: boolean;
}

/** Result of the pure per-file refresh decision. */
export interface ManagedFileDecision {
  status: RefreshOutcome['status'];
  /** Whether to write `render` to disk. */
  write: boolean;
  /** Hash to record in the new sidecar, or `null` to preserve the prior entry (or stay untracked). */
  recordHash: string | null;
}

/**
 * Decide what to do with one managed scaffold file. Pure — all filesystem state is passed in — so
 * the decision table is unit-testable in isolation.
 *
 * | On-disk state                                   | Result        |
 * |-------------------------------------------------|---------------|
 * | missing                                         | `recreated`   |
 * | matches the current render                      | `unchanged`   |
 * | differs from render, matches recorded hash      | `updated`     |
 * | differs from render & recorded (or untracked)   | `conflict` *  |
 * | …same, with `force`                             | `overwritten` |
 *
 * \* `unchanged` also adopts an untracked-but-in-sync file by recording its hash.
 */
export function decideManagedFile(input: ManagedFileDecisionInput): ManagedFileDecision {
  const { render, current, recordedHash, force } = input;
  const renderHash = hashScaffoldContent(render);

  if (current === null) return { status: 'recreated', write: true, recordHash: renderHash };

  const currentHash = hashScaffoldContent(current);
  if (currentHash === renderHash)
    return { status: 'unchanged', write: false, recordHash: renderHash };

  // Content differs from the current render.
  if (recordedHash !== null && currentHash === recordedHash) {
    // Pristine: the file is exactly what the toolkit last wrote, so it is safe to upgrade.
    return { status: 'updated', write: true, recordHash: renderHash };
  }

  // Diverged from the recorded hash (user-edited) or untracked and not in sync.
  if (force) return { status: 'overwritten', write: true, recordHash: renderHash };
  return { status: 'conflict', write: false, recordHash: null };
}

/**
 * Seed `.aipm/scaffold.json` for a freshly scaffolded repo, recording the hash of every managed
 * scaffold file as just written by `aipm init`. Called by {@link runInit} after the seed tree is
 * written so the first `--refresh` has a baseline.
 */
export function writeScaffoldSidecar(repoRoot: string): void {
  const entries: SidecarEntry[] = buildManagedScaffoldFiles().map((file) => ({
    path: file.path,
    hash: hashScaffoldContent(file.content),
  }));
  const abs = sidecarPath(repoRoot);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, serializeScaffoldSidecar(entries), 'utf-8');
}

/**
 * Refresh the toolkit-owned scaffold files of an existing repo at `repoRoot`, re-rendering each
 * from the installed tooling and updating it in place when safe (see {@link decideManagedFile}).
 * Writes the updated `.aipm/scaffold.json` sidecar and returns one {@link RefreshOutcome} per
 * managed file. Never throws on conflict — conflicts are reported, not failures.
 */
export function runRefreshScaffold(repoRoot: string, opts: RefreshOptions = {}): RefreshOutcome[] {
  const force = opts.force ?? false;
  const resolved = path.resolve(repoRoot);
  const recorded = readSidecar(resolved);

  const outcomes: RefreshOutcome[] = [];
  const newEntries: SidecarEntry[] = [];

  for (const file of buildManagedScaffoldFiles()) {
    const abs = path.join(resolved, file.path);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
    const recordedHash = recorded.get(file.path) ?? null;

    const decision = decideManagedFile({ render: file.content, current, recordedHash, force });

    if (decision.write) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, file.content, 'utf-8');
    }

    if (decision.recordHash !== null) {
      newEntries.push({ path: file.path, hash: decision.recordHash });
    } else if (recordedHash !== null) {
      // Conflict left untouched: preserve the prior recorded hash so it stays tracked.
      newEntries.push({ path: file.path, hash: recordedHash });
    }

    outcomes.push({ path: file.path, status: decision.status });
  }

  const sidecarAbs = sidecarPath(resolved);
  fs.mkdirSync(path.dirname(sidecarAbs), { recursive: true });
  fs.writeFileSync(sidecarAbs, serializeScaffoldSidecar(newEntries), 'utf-8');

  return outcomes;
}
