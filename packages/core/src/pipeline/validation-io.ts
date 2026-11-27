import * as fs from 'node:fs';
import * as path from 'node:path';

export type FreshnessIoHandler = (error: Error, plugin?: string) => void;

/** Return whether the opt-in outcome captured a filesystem failure. */
export function captureValidationIo(
  err: unknown,
  onIoError: FreshnessIoHandler | undefined,
  plugin?: string,
): boolean {
  if (onIoError !== undefined && err instanceof Error && err.cause instanceof Error) {
    if (captureValidationIo(err.cause, onIoError, plugin)) return true;
  }
  if (
    onIoError === undefined ||
    !(err instanceof Error) ||
    !('code' in err) ||
    typeof err.code !== 'string' ||
    !/^(?:E[A-Z0-9]+|ERR_FS_[A-Z_]+)$/.test(err.code)
  ) {
    return false;
  }
  onIoError(err, plugin);
  return true;
}

export function checkValidationIo<T>(
  check: () => T,
  onIoError: FreshnessIoHandler | undefined,
  plugin?: string,
): T | undefined {
  try {
    return check();
  } catch (err) {
    if (!captureValidationIo(err, onIoError, plugin)) throw err;
    return undefined;
  }
}

/** Report an unusable filesystem entry with the same context as a native filesystem error. */
export function invalidInputPath(code: string, file: fs.PathLike, reason: string): Error {
  return Object.assign(new Error(`${code}: ${reason}, '${String(file)}'`), { code });
}

/** A missing optional path is distinct from an occupied path with a broken link. */
export function strictExists(file: fs.PathLike): boolean {
  if (fs.statSync(file, { throwIfNoEntry: false }) !== undefined) return true;
  if (fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined) {
    throw invalidInputPath('ENOENT', file, 'dangling symbolic link');
  }
  if (typeof file === 'string') {
    const parent = path.dirname(file);
    if (parent !== file && parent !== '.') strictExists(parent);
  }
  return false;
}

export function assertRegularFile(file: string): void {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw invalidInputPath('EINVAL', file, 'expected a regular file');
}

export function assertReadableFile(file: string): void {
  assertRegularFile(file);
  fs.accessSync(file, fs.constants.R_OK);
}

/** Read JSON for an existing schema check, retaining its legacy parse diagnostic for callers
 * without an I/O handler. An intercepted I/O failure has no JSON to validate.
 */
export function readValidationJson(
  file: string,
  onIoError: FreshnessIoHandler | undefined,
  plugin: string,
): { ok: true; value: unknown } | { ok: false; error: unknown } | undefined {
  let content: string;
  try {
    if (onIoError !== undefined) assertRegularFile(file);
    content = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    return captureValidationIo(error, onIoError, plugin) ? undefined : { ok: false, error };
  }
  try {
    return { ok: true, value: JSON.parse(content) as unknown };
  } catch (error) {
    return { ok: false, error };
  }
}
