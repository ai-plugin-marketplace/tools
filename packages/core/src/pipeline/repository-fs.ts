import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BuildFreshnessIoFinding } from './types.js';

interface RepositoryIo {
  repoRoot: string;
  pluginDirs: Set<string>;
  tempDirs: Set<string>;
  plugin?: string;
  findings: Map<string, BuildFreshnessIoFinding>;
  errors: WeakSet<object>;
}

const repositoryIo = new AsyncLocalStorage<RepositoryIo>();

export function observeRepositoryIo<T>(
  targetPath: string,
  run: (findings: ReadonlyMap<string, BuildFreshnessIoFinding>) => Promise<T>,
): Promise<T> {
  const findings = new Map<string, BuildFreshnessIoFinding>();
  return repositoryIo.run(
    {
      repoRoot: path.resolve(targetPath),
      pluginDirs: new Set(),
      tempDirs: new Set(),
      findings,
      errors: new WeakSet(),
    },
    () => run(findings),
  );
}

export function setRepositoryPaths(repoRoot: string, pluginDirs: readonly string[]): void {
  const io = repositoryIo.getStore();
  if (io === undefined) return;
  io.repoRoot = repoRoot;
  for (const dir of pluginDirs) io.pluginDirs.add(dir);
}

function includesPath(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function record(error: unknown, file: string): void {
  const io = repositoryIo.getStore();
  if (io === undefined || !(error instanceof Error) || io.errors.has(error)) return;
  const code = 'code' in error ? error.code : undefined;
  if (typeof code !== 'string' || !/^(?:E[A-Z0-9]+|ERR_FS_[A-Z_]+)$/.test(code)) return;
  const failedPath = 'path' in error && typeof error.path === 'string' ? error.path : file;
  io.errors.add(error);
  const key = path.resolve(failedPath) + '\0' + code;
  if (io.findings.has(key)) return;

  let plugin: string | undefined;
  for (const dir of io.pluginDirs) {
    if (includesPath(dir, failedPath)) {
      plugin = path.basename(dir);
      break;
    }
  }
  plugin ??= io.plugin;
  io.findings.set(key, {
    severity: 'hard',
    code: 'freshness-io',
    ...(plugin === undefined ? {} : { plugin }),
    message: error.message,
  });
}

export function withRepositoryPlugin<T>(plugin: string, run: () => T): T {
  const io = repositoryIo.getStore();
  return io === undefined || path.resolve(plugin) === io.repoRoot
    ? run()
    : repositoryIo.run({ ...io, plugin: path.basename(plugin) }, run);
}

export function isObservedIoError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (repositoryIo.getStore()?.errors.has(error) === true ||
      (error.cause !== undefined && isObservedIoError(error.cause)))
  );
}

/** Keep results from independent checks when one cannot read its inputs. */
export function collectReadableChecks<T>(checks: readonly (() => T[])[]): T[] {
  return checks.flatMap((check) => {
    try {
      return check();
    } catch (error) {
      if (!isObservedIoError(error)) throw error;
      return [];
    }
  });
}

function invalidPath(code: string, file: string, reason: string): Error {
  return Object.assign(new Error(`${code}: ${reason}, '${file}'`), { code, path: file });
}

/** Resolve an occupied path, distinguishing absence from a broken link at any component. */
function lookup(file: string): fs.Stats | undefined {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat !== undefined) return stat;
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw invalidPath('ENOENT', file, 'dangling symbolic link');
  }
  const parent = path.dirname(file);
  if (parent !== file && parent !== '.') lookup(parent);
  return undefined;
}

function observe<T>(file: string, operation: () => T): T {
  if (repositoryIo.getStore() === undefined) return operation();
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // Optional probes such as skills-lock.json routinely read a path that is absent.
      try {
        if (lookup(path.resolve(file)) === undefined) throw error;
      } catch (lookupError) {
        if (lookupError === error) throw error;
        record(error, file);
        record(lookupError, file);
        throw error;
      }
    }
    record(error, file);
    throw error;
  }
}

function probe(file: string, operation: () => void): void {
  try {
    observe(file, operation);
  } catch (error) {
    if (!isObservedIoError(error)) throw error;
  }
}

function existsSync(file: string): boolean {
  if (repositoryIo.getStore() !== undefined) probe(file, () => void lookup(path.resolve(file)));
  // Keep the legacy answer, even when a broken link was found by the probe.
  return fs.existsSync(file);
}

function statSync(file: string): fs.Stats;
function statSync(file: string, options: { throwIfNoEntry: false }): fs.Stats | undefined;
function statSync(file: string, options?: { throwIfNoEntry: false }): fs.Stats | undefined {
  if (options === undefined) return observe(file, () => fs.statSync(file));
  if (repositoryIo.getStore() !== undefined) probe(file, () => void lookup(path.resolve(file)));
  return observe(file, () => fs.statSync(file, options));
}

function assertSafeRead(file: string): void {
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    throw invalidPath(stat.isDirectory() ? 'EISDIR' : 'EINVAL', file, 'expected a regular file');
  }
}

function readFileSync(file: string): Buffer;
function readFileSync(file: string, encoding: BufferEncoding): string;
function readFileSync(file: string, encoding?: BufferEncoding): string | Buffer {
  return observe(file, () => {
    // Check before opening. Reading a FIFO via readFileSync can block the entire process.
    if (repositoryIo.getStore() !== undefined) assertSafeRead(file);
    return fs.readFileSync(file, encoding);
  });
}

function readdirSync(dir: string): string[];
function readdirSync(dir: string, options: { withFileTypes: true }): fs.Dirent[];
function readdirSync(dir: string, options?: { withFileTypes: true }): string[] | fs.Dirent[] {
  if (options === undefined) {
    const entries = observe(dir, () => fs.readdirSync(dir));
    if (repositoryIo.getStore() !== undefined) {
      for (const name of entries) {
        const file = path.resolve(dir, name);
        probe(file, () => void lookup(file));
      }
    }
    return entries;
  }
  const entries = observe(dir, () => fs.readdirSync(dir, options));
  if (repositoryIo.getStore() !== undefined) {
    // Discovery still ignores aliases. A broken alias should never hide a valid sibling.
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        const file = path.resolve(dir, entry.name);
        probe(file, () => void lookup(file));
      }
    }
  }
  return entries;
}

/** A manifest reference can be used by a host even if it isn't under a conventional component directory. */
export function referenceExists(file: string, expected?: 'file' | 'directory'): boolean {
  const present = existsSync(file);
  if (present && repositoryIo.getStore() !== undefined) {
    probe(file, () => {
      const stat = fs.statSync(file);
      if (expected === 'directory' && !stat.isDirectory()) {
        throw invalidPath('ENOTDIR', file, 'expected a directory');
      }
      if (stat.isDirectory()) {
        if (expected === 'file') throw invalidPath('EISDIR', file, 'expected a regular file');
        fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK);
      } else {
        readFileSync(file);
      }
    });
  }
  return present;
}

export function inputExists(file: string, expected: 'file' | 'directory'): boolean {
  const present = existsSync(file);
  if (present && repositoryIo.getStore() !== undefined) {
    probe(file, () => {
      const stat = fs.statSync(file);
      if (expected === 'file' && !stat.isFile()) {
        throw invalidPath(
          stat.isDirectory() ? 'EISDIR' : 'EINVAL',
          file,
          'expected a regular file',
        );
      }
      if (expected === 'directory' && !stat.isDirectory()) {
        throw invalidPath('ENOTDIR', file, 'expected a directory');
      }
    });
  }
  return present;
}

export function isFileEntry(dir: string, entry: fs.Dirent, extension: string): boolean {
  if (!entry.name.endsWith(extension)) return false;
  if (!entry.isFile() && repositoryIo.getStore() !== undefined) {
    inputExists(path.join(dir, entry.name), 'file');
  }
  return entry.isFile();
}

export function directoryExists(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const directory = statSync(dir).isDirectory();
  if (!directory) record(invalidPath('ENOTDIR', dir, 'expected a directory'), dir);
  return directory;
}

/** jiti opens the config itself, so check its input at the same boundary before handing it over. */
export function readConfig<T>(file: string, load: () => Promise<T>): Promise<T> {
  if (repositoryIo.getStore() === undefined) return load();
  readFileSync(file);
  return load().catch((error: unknown) => {
    record(error, file);
    throw error;
  });
}

function assertSafeOutput(file: string, allowDanglingLeaf = false): fs.Stats | undefined {
  const io = repositoryIo.getStore();
  if (io === undefined) return undefined;
  if (!includesPath(io.repoRoot, file)) {
    if ([...io.tempDirs].some((dir) => includesPath(dir, file))) {
      return fs.statSync(file, { throwIfNoEntry: false });
    }
    throw invalidPath('EINVAL', file, 'output path resolves outside the repository');
  }

  const realRoot = fs.realpathSync.native(io.repoRoot);
  let current = file;
  for (;;) {
    const stat = fs.statSync(current, { throwIfNoEntry: false });
    if (stat !== undefined) {
      if (!includesPath(realRoot, fs.realpathSync.native(current))) {
        throw invalidPath('EINVAL', current, 'output path resolves outside the repository');
      }
      return current === file ? stat : undefined;
    }
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      const failure = invalidPath('ENOENT', current, 'dangling symbolic link');
      if (!allowDanglingLeaf || current !== file) throw failure;
      record(failure, file);
      const parent = fs.realpathSync.native(path.dirname(file));
      const target = path.resolve(parent, fs.readlinkSync(file));
      const realParent = fs.realpathSync.native(path.dirname(target));
      if (!includesPath(realRoot, realParent)) {
        throw invalidPath('EINVAL', current, 'output path resolves outside the repository');
      }
      // A second dangling link could redirect the otherwise safe-looking target.
      lookup(target);
      return undefined;
    }
    current = path.dirname(current);
  }
}

export const repositoryFs = {
  existsSync,
  statSync,
  readFileSync,
  readdirSync,
  lstatSync(file: string, options: { throwIfNoEntry: false }): fs.Stats | undefined {
    if (repositoryIo.getStore() !== undefined) probe(file, () => void lookup(path.resolve(file)));
    return observe(file, () => fs.lstatSync(file, options));
  },
  realpathSync: Object.assign((file: string) => observe(file, () => fs.realpathSync(file)), {
    native: (file: string) => observe(file, () => fs.realpathSync.native(file)),
  }),
  copyFileSync(source: string, destination: string): void {
    observe(source, () => {
      if (repositoryIo.getStore() !== undefined) assertSafeRead(source);
      assertSafeOutput(destination);
      fs.copyFileSync(source, destination);
    });
  },
  mkdtempSync(prefix: string): string {
    const dir = observe(path.dirname(prefix), () => fs.mkdtempSync(prefix));
    repositoryIo.getStore()?.tempDirs.add(dir);
    return dir;
  },
  mkdirSync(dir: string, options: { recursive: true }): string | undefined {
    return observe(dir, () => {
      assertSafeOutput(dir);
      return fs.mkdirSync(dir, options);
    });
  },
  writeFileSync(file: string | number, content: string | Buffer, encoding?: BufferEncoding): void {
    if (typeof file === 'number') {
      fs.writeFileSync(file, content, encoding);
      return;
    }
    observe(file, () => {
      const stat = assertSafeOutput(path.resolve(file), true);
      if (stat !== undefined && !stat.isFile()) {
        throw invalidPath('EINVAL', file, 'expected a regular file');
      }
      fs.writeFileSync(file, content, encoding);
    });
  },
  rmSync(file: string, options?: fs.RmOptions): void {
    observe(file, () => {
      const temps = repositoryIo.getStore()?.tempDirs;
      if (!temps?.has(file)) assertSafeOutput(path.resolve(path.dirname(file)));
      // Bundlers recreate the same temporary directory after clearing it, so keep its registration.
      fs.rmSync(file, options);
    });
  },
  openSync: (file: string, flags: string, mode: number) =>
    observe(file, () => fs.openSync(file, flags, mode)),
  closeSync: (fd: number) => {
    fs.closeSync(fd);
  },
  fchmodSync: (fd: number, mode: number) => {
    fs.fchmodSync(fd, mode);
  },
  chmodSync: (file: string, mode: number) => {
    observe(file, () => {
      fs.chmodSync(file, mode);
    });
  },
  renameSync: (oldPath: string, newPath: string) => {
    observe(oldPath, () => {
      fs.renameSync(oldPath, newPath);
    });
  },
};
