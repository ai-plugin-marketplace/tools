/**
 * Tests for {@link resolveBinary}'s parsing of `which`/`where` output.
 *
 * Regression guard: Windows `where` emits CRLF line endings and can list multiple matches.
 * Splitting only on `\n` left a trailing `\r` on the first path (e.g. `C:\path\bin.exe\r`),
 * producing a path that fails to `spawnSync`/`existsSync` even though the binary is present.
 */

import { spawnSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { resolveBinary } from './subprocess-script.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockSpawnSync = vi.mocked(spawnSync);

describe('resolveBinary', () => {
  it('strips a trailing CR left by CRLF-terminated `where` output (Windows)', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'C:\\Program Files\\jq\\jq.exe\r\nC:\\Other\\jq.exe\r\n',
    } as ReturnType<typeof spawnSync>);

    expect(resolveBinary('jq')).toBe('C:\\Program Files\\jq\\jq.exe');
  });

  it('resolves the first of multiple LF-terminated matches (POSIX)', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: '/usr/bin/jq\n/usr/local/bin/jq\n',
    } as ReturnType<typeof spawnSync>);

    expect(resolveBinary('jq')).toBe('/usr/bin/jq');
  });

  it('returns undefined when the probe exits non-zero (binary not on PATH)', () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
    } as ReturnType<typeof spawnSync>);

    expect(resolveBinary('nonexistent-binary')).toBeUndefined();
  });

  it('returns undefined when stdout is empty after trimming', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: '\n',
    } as ReturnType<typeof spawnSync>);

    expect(resolveBinary('nonexistent-binary')).toBeUndefined();
  });
});
