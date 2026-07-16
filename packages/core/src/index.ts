/**
 * `@ai-plugin-marketplace/core` — public API.
 *
 * Only the exports listed here are part of the public contract. Per §8.1 of the architecture
 * spec (`docs/specs/architecture.md`), the package's only public subpath is the root — types
 * and functions import from `@ai-plugin-marketplace/core` directly, not from `/types`,
 * `/config`, `/targets`, or any internal subpath.
 *
 * @packageDocumentation
 */

export { defineConfig, defineRepoConfig, defineWorkspace } from './config.js';
export type {
  AipmConfig,
  AipmConfigInput,
  AipmRepoConfig,
  AipmRepoConfigInput,
  AipmWorkspace,
  AipmWorkspaceInput,
} from './config.js';

export {
  build,
  validate,
  scaffold,
  init,
  refreshScaffold,
  migrate,
  checkSupport,
  addTarget,
  listTargets,
} from './pipeline/operations.js';

export { lint } from './lint/index.js';
export type {
  Diagnostic,
  DiscoveryMode,
  Document,
  Fix,
  FrontmatterDocument,
  JsonDocument,
  LintOptions,
  LintResult,
  Position,
  Range,
  Rule,
  RuleContext,
  YamlDocument,
} from './lint/index.js';

export type {
  TargetId,
  BuildOptions,
  BuildResult,
  GeneratedFile,
  GeneratedFileTarget,
  ValidateOptions,
  ValidationResult,
  Finding,
  FindingCode,
  ScaffoldOptions,
  InitOptions,
  RefreshOptions,
  RefreshOutcome,
  MigrateOptions,
  MigrateResult,
  SupportReport,
} from './pipeline/types.js';
