/**
 * Tests for the `aipm init --refresh` engine: the pure per-file decision table
 * ({@link decideManagedFile}), the hash/serialization helpers, and the filesystem orchestrator
 * ({@link runRefreshScaffold}) exercised against a real temp repo seeded by `runInit`.
 *
 * Covers the safety contract: pristine toolkit-owned files upgrade, user-edited files surface as
 * conflicts (untouched without `--force`), missing files are recreated, and a repo with no sidecar
 * bootstraps (in-sync files adopted, diverged files flagged).
 *
 * @see docs/specs/scaffold-refresh-and-upgrade.md
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit } from './init.js';
import {
  decideManagedFile,
  hashScaffoldContent,
  runRefreshScaffold,
  serializeScaffoldSidecar,
} from './scaffold-refresh.js';

const CI_REL = '.github/workflows/ci.yml';
const GITIGNORE_REL = '.gitignore';
const SIDECAR_REL = '.aipm/scaffold.json';

describe('hashScaffoldContent', () => {
  it('is deterministic and sha256-prefixed hex', () => {
    expect(hashScaffoldContent('x')).toBe(hashScaffoldContent('x'));
    expect(hashScaffoldContent('x')).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('differs for different content', () => {
    expect(hashScaffoldContent('a')).not.toBe(hashScaffoldContent('b'));
  });
});

describe('serializeScaffoldSidecar', () => {
  it('sorts files by path, stamps version 1, ends with a newline', () => {
    const out = serializeScaffoldSidecar([
      { path: 'b.txt', hash: 'h2' },
      { path: 'a.txt', hash: 'h1' },
    ]);
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out) as { version: number; files: { path: string }[] };
    expect(parsed.version).toBe(1);
    expect(parsed.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
  });
});

describe('decideManagedFile', () => {
  const render = 'canonical\n';
  const renderHash = hashScaffoldContent(render);

  it('recreates a missing file', () => {
    expect(decideManagedFile({ render, current: null, recordedHash: null, force: false })).toEqual({
      status: 'recreated',
      write: true,
      recordHash: renderHash,
    });
  });

  it('leaves an in-sync file unchanged and records its hash (adoption)', () => {
    expect(
      decideManagedFile({ render, current: render, recordedHash: null, force: false }),
    ).toEqual({ status: 'unchanged', write: false, recordHash: renderHash });
  });

  it('updates a pristine file that lags the render', () => {
    const old = 'old\n';
    expect(
      decideManagedFile({
        render,
        current: old,
        recordedHash: hashScaffoldContent(old),
        force: false,
      }),
    ).toEqual({ status: 'updated', write: true, recordHash: renderHash });
  });

  it('reports a conflict for a tracked file the user edited', () => {
    expect(
      decideManagedFile({
        render,
        current: 'edited\n',
        recordedHash: hashScaffoldContent('what-the-toolkit-wrote\n'),
        force: false,
      }),
    ).toEqual({ status: 'conflict', write: false, recordHash: null });
  });

  it('reports a conflict for an untracked, out-of-sync file', () => {
    expect(
      decideManagedFile({ render, current: 'different\n', recordedHash: null, force: false }),
    ).toEqual({ status: 'conflict', write: false, recordHash: null });
  });

  it('overwrites a conflicting file under force', () => {
    expect(
      decideManagedFile({ render, current: 'edited\n', recordedHash: null, force: true }),
    ).toEqual({ status: 'overwritten', write: true, recordHash: renderHash });
  });
});

describe('runRefreshScaffold', () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-refresh-test-'));
    repoDir = path.join(tmpDir, 'repo');
    await runInit(repoDir);
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  const read = (rel: string): string => fs.readFileSync(path.join(repoDir, rel), 'utf-8');
  const write = (rel: string, content: string): void => {
    fs.writeFileSync(path.join(repoDir, rel), content, 'utf-8');
  };
  const exists = (rel: string): boolean => fs.existsSync(path.join(repoDir, rel));
  const statusFor = (rel: string, outcomes: ReturnType<typeof runRefreshScaffold>): string =>
    outcomes.find((o) => o.path === rel)?.status ?? 'MISSING';

  it('reports all managed files unchanged immediately after init', () => {
    const outcomes = runRefreshScaffold(repoDir);
    // `.gitignore` is seed-only; the only refresh-managed file is `ci.yml` (#19).
    expect(outcomes.map((o) => o.path).sort()).toEqual([CI_REL]);
    expect(outcomes.every((o) => o.status === 'unchanged')).toBe(true);
  });

  it('never refresh-manages .gitignore: it stays out of outcomes and user edits survive (#19)', () => {
    // `.gitignore` is seeded by init but owned by the user thereafter. Refresh must never report it
    // (no perpetual conflict) nor touch it (no clobbering user additions), with or without --force.
    const edited = `${read(GITIGNORE_REL)}my-custom-dir/\n`;
    write(GITIGNORE_REL, edited);
    for (const opts of [undefined, { force: true }]) {
      const outcomes = runRefreshScaffold(repoDir, opts);
      expect(outcomes.some((o) => o.path === GITIGNORE_REL)).toBe(false);
      expect(read(GITIGNORE_REL)).toBe(edited);
    }
  });

  it('reports a conflict and leaves a user-edited file untouched (no --force)', () => {
    write(CI_REL, 'name: Custom\n');
    const outcomes = runRefreshScaffold(repoDir);
    expect(statusFor(CI_REL, outcomes)).toBe('conflict');
    expect(read(CI_REL)).toBe('name: Custom\n');
  });

  it('overwrites a user-edited file under --force, restoring the render', () => {
    const original = read(CI_REL);
    write(CI_REL, 'name: Custom\n');
    const outcomes = runRefreshScaffold(repoDir, { force: true });
    expect(statusFor(CI_REL, outcomes)).toBe('overwritten');
    expect(read(CI_REL)).toBe(original);
  });

  it('recreates a deleted managed file', () => {
    fs.rmSync(path.join(repoDir, CI_REL));
    const outcomes = runRefreshScaffold(repoDir);
    expect(statusFor(CI_REL, outcomes)).toBe('recreated');
    expect(exists(CI_REL)).toBe(true);
  });

  it('updates a pristine file that lags the render', () => {
    // Simulate an older toolkit render: stale on-disk content whose hash the sidecar still records.
    const stale = 'name: Stale CI\n';
    write(CI_REL, stale);
    write(
      SIDECAR_REL,
      `${JSON.stringify(
        { version: 1, files: [{ path: CI_REL, hash: hashScaffoldContent(stale) }] },
        null,
        2,
      )}\n`,
    );
    const outcomes = runRefreshScaffold(repoDir);
    expect(statusFor(CI_REL, outcomes)).toBe('updated');
    expect(read(CI_REL)).not.toBe(stale);
  });

  it('bootstraps a sidecar-less repo: adopts in-sync files and re-seeds the sidecar', () => {
    fs.rmSync(path.join(repoDir, SIDECAR_REL));
    const outcomes = runRefreshScaffold(repoDir);
    expect(outcomes.every((o) => o.status === 'unchanged')).toBe(true);
    expect(exists(SIDECAR_REL)).toBe(true);
  });

  it('bootstraps a sidecar-less repo: flags diverged files as conflicts', () => {
    fs.rmSync(path.join(repoDir, SIDECAR_REL));
    write(CI_REL, 'name: Hand-rolled\n');
    const outcomes = runRefreshScaffold(repoDir);
    expect(statusFor(CI_REL, outcomes)).toBe('conflict');
    expect(read(CI_REL)).toBe('name: Hand-rolled\n');
  });

  it('converges: after --force, a subsequent refresh reports unchanged', () => {
    write(CI_REL, 'name: Custom\n');
    runRefreshScaffold(repoDir, { force: true });
    const second = runRefreshScaffold(repoDir);
    expect(second.every((o) => o.status === 'unchanged')).toBe(true);
  });
});
