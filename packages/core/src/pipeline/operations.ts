/**
 * Public operation implementations.
 *
 * These are stubs for the skeleton commit. Stages 2–6 of the bootstrap plan fill them in.
 * Every function here has a pinned signature per §8.1 of the spec; the implementations evolve
 * without changing the contract.
 */

import { TARGET_IDS } from './types.js';
import type {
  BuildOptions,
  BuildResult,
  MigrateOptions,
  MigrateResult,
  ScaffoldOptions,
  SupportReport,
  TargetId,
  ValidateOptions,
  ValidationResult,
} from './types.js';

class NotImplementedError extends Error {
  constructor(operation: string) {
    super(`${operation} is not implemented in this skeleton build. See bootstrap plan §13.`);
    this.name = 'NotImplementedError';
  }
}

export function build(_path: string, _opts?: BuildOptions): Promise<BuildResult[]> {
  return Promise.reject(new NotImplementedError('build'));
}

export function validate(_path: string, _opts?: ValidateOptions): Promise<ValidationResult> {
  return Promise.reject(new NotImplementedError('validate'));
}

export function scaffold(_name: string, _opts: ScaffoldOptions): Promise<void> {
  return Promise.reject(new NotImplementedError('scaffold'));
}

/**
 * No-op in v0.1.0 per §8.1 of the spec. Always returns `status: 'no-migrations-needed'` because
 * §9.4 constrains every `schemaVersion` to a single value. When real migrations ship, this
 * must distinguish up-to-date from unknown-future-version.
 */
export function migrate(_path: string, _opts?: MigrateOptions): Promise<MigrateResult> {
  return Promise.resolve({
    status: 'no-migrations-needed',
    migrationsApplied: 0,
    filesChanged: [],
  });
}

export function checkSupport(_pluginDir: string): Promise<SupportReport> {
  return Promise.reject(new NotImplementedError('checkSupport'));
}

export function addTarget(_pluginDir: string, _target: TargetId): Promise<void> {
  return Promise.reject(new NotImplementedError('addTarget'));
}

export function listTargets(): readonly TargetId[] {
  return TARGET_IDS;
}
