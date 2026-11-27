import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as nodeModule from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BuildFreshnessIoFinding } from './types.js';

interface RepositoryIo {
  repoRoot: string;
  pluginDirs: Set<string>;
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

function observe<T>(file: string, operation: () => T, resolvingModule = false): T {
  if (repositoryIo.getStore() === undefined) return operation();
  try {
    return operation();
  } catch (error) {
    // A resolver may try a directory index below a regular file before trying another
    // extension or parent. ENOTDIR on that candidate means the candidate is absent.
    if (resolvingModule && (error as NodeJS.ErrnoException).code === 'ENOTDIR') throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // Optional probes such as skills-lock.json routinely read a path that is absent.
      try {
        if (lookup(path.resolve(file)) === undefined) throw error;
      } catch (lookupError) {
        if (lookupError === error) throw error;
        record(lookupError, file);
        if (isObservedIoError(lookupError)) repositoryIo.getStore()?.errors.add(error);
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
  // existsSync returns false for a NUL in a manifest reference. statSync would throw.
  if (repositoryIo.getStore() !== undefined && !file.includes('\0')) {
    probe(file, () => void lookup(path.resolve(file)));
  }
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
  return observe(dir, () =>
    options === undefined ? fs.readdirSync(dir) : fs.readdirSync(dir, options),
  );
}

/** Discovery considers each entry in the plugins root, but still skips symlink aliases. */
export function probeDiscoveryAlias(dir: string, entry: fs.Dirent): void {
  if (observesRepositoryIo() && entry.isSymbolicLink()) existsSync(path.join(dir, entry.name));
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
  if (observesRepositoryIo() && entry.isSymbolicLink()) existsSync(path.join(dir, entry.name));
  return entry.isFile();
}

export function directoryExists(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const directory = statSync(dir).isDirectory();
  if (!directory) record(invalidPath('ENOTDIR', dir, 'expected a directory'), dir);
  return directory;
}

export function observesRepositoryIo(): boolean {
  return repositoryIo.getStore() !== undefined;
}

const configModuleIo = new AsyncLocalStorage<boolean>();
const registerModuleHooks = (nodeModule as Partial<typeof nodeModule>).registerHooks;
export const observesNativeModuleGraph = registerModuleHooks !== undefined;
let configModuleHooks: ReturnType<typeof nodeModule.registerHooks> | undefined;
let activeConfigLoads = 0;

function nativeModulePath(specifier: string, parentURL?: string): string | undefined {
  if (path.isAbsolute(specifier)) return specifier;
  if (!specifier.startsWith('file:') && !/^\.\.?\//.test(specifier)) return undefined;
  if (!URL.canParse(specifier, parentURL)) return undefined;
  const url = new URL(specifier, parentURL);
  if (url.protocol !== 'file:' || /%(?:2f|5c)/i.test(url.pathname)) return undefined;
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

/** Jiti delegates native modules to Node. Scope the hooks to active observed config loads. */
export async function withConfigModuleReads<T>(load: () => Promise<T>): Promise<T> {
  if (registerModuleHooks === undefined) return load();
  if (activeConfigLoads === 0) {
    configModuleHooks = registerModuleHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          if (configModuleIo.getStore()) {
            const file = nativeModulePath(specifier, context.parentURL);
            if (file !== undefined) existsSync(file);
          }
          throw error;
        }
      },
      load(url, context, nextLoad) {
        if (configModuleIo.getStore() && url.startsWith('file:')) {
          readFileSync(fileURLToPath(url));
        }
        return nextLoad(url, context);
      },
    });
  }
  activeConfigLoads++;
  try {
    return await configModuleIo.run(true, load);
  } finally {
    if (--activeConfigLoads === 0) {
      configModuleHooks?.deregister();
      configModuleHooks = undefined;
    }
  }
}

function modulePath(file: string | URL): string {
  return typeof file === 'string' ? file : fileURLToPath(file);
}

/** Jiti probes package metadata and candidates by URL as well as by path. */
export const configModuleFs: object = {
  ...fs,
  statSync(file: string | URL, options?: { throwIfNoEntry: false }): fs.Stats | undefined {
    const filename = modulePath(file);
    return observe(
      filename,
      () => {
        const stat = options === undefined ? fs.statSync(file) : fs.statSync(file, options);
        if (stat === undefined) {
          lookup(filename);
        } else if (!stat.isDirectory() && !stat.isFile()) {
          record(invalidPath('EINVAL', filename, 'expected a regular file'), filename);
        }
        return stat;
      },
      true,
    );
  },
  lstatSync(file: string | URL): fs.Stats {
    return observe(modulePath(file), () => fs.lstatSync(file));
  },
  realpathSync(file: string | URL): string {
    return observe(modulePath(file), () => fs.realpathSync(file));
  },
  readFileSync(file: string | URL, encoding: BufferEncoding): string {
    return readFileSync(modulePath(file), encoding);
  },
};

function assertNonBlockingWrite(file: string): void {
  if (observesRepositoryIo() && fs.statSync(file, { throwIfNoEntry: false })?.isFIFO()) {
    throw invalidPath('EINVAL', file, 'cannot write to a FIFO');
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
      assertNonBlockingWrite(destination);
      fs.copyFileSync(source, destination);
    });
  },
  mkdtempSync: (prefix: string) => observe(path.dirname(prefix), () => fs.mkdtempSync(prefix)),
  mkdirSync: (dir: string, options: { recursive: true }) =>
    observe(dir, () => fs.mkdirSync(dir, options)),
  writeFileSync(file: string | number, content: string | Buffer, encoding?: BufferEncoding): void {
    if (typeof file === 'number') {
      fs.writeFileSync(file, content, encoding);
      return;
    }
    observe(file, () => {
      assertNonBlockingWrite(file);
      fs.writeFileSync(file, content, encoding);
    });
  },
  rmSync(file: string, options?: fs.RmOptions): void {
    observe(file, () => {
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
