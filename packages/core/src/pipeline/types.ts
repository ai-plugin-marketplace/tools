/**
 * Public types for the core API. These are the contract surface per §8.1 of the spec.
 */

/**
 * Canonical list of target IDs known to this toolkit version. Runtime-exposed so
 * `listTargets()` and config validation share one source of truth.
 */
export const TARGET_IDS = ['claude', 'cursor', 'gemini', 'kiro', 'vercel'] as const;

export type TargetId = (typeof TARGET_IDS)[number];

// ---------------------------------------------------------------------------
// Build

export interface BuildOptions {
  /** Abort after the first hard validation finding. Default: false. */
  failFast?: boolean;
}

export interface BuildResult {
  /** Plugin directory name, e.g. 'skill-evaluator'. */
  plugin: string;
  /** Absolute path to the plugin directory. */
  pluginDir: string;
  /** Every file the build produced or verified as up-to-date. */
  artifacts: GeneratedFile[];
  /** Wall-clock time in milliseconds. */
  durationMs: number;
}

export interface GeneratedFile {
  /** Absolute path. */
  path: string;
  /** The author-authored file this was generated from, if applicable. */
  source?: string;
  /** Which target's build step produced this file. */
  target: TargetId;
}

// ---------------------------------------------------------------------------
// Validate

export interface ValidateOptions {
  /** When true, skip the freshness check (§10.5). Default: false. */
  skipFreshness?: boolean;
}

export interface ValidationResult {
  findings: Finding[];
  /** True iff no hard findings were emitted. Soft findings do not flip this. */
  passed: boolean;
}

/**
 * Enumerated finding codes. Additive — new codes arrive in toolkit MINOR releases; removing
 * or renaming a code is MAJOR. Consumers SHOULD handle unknown codes gracefully.
 */
export type FindingCode =
  | 'envelope-invalid'
  | 'envelope-adherence'
  | 'schema-invalid'
  | 'name-consistency'
  | 'mcp-key-sync'
  | 'marketplace-registration'
  | 'freshness';

export interface Finding {
  severity: 'hard' | 'soft';
  code: FindingCode;
  /** Plugin name, if the finding is scoped to a specific plugin. */
  plugin?: string;
  /** Human-readable message. */
  message: string;
  /** Optional remediation hint. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Scaffold

export interface ScaffoldOptions {
  /** Targets to scaffold for. Defaults to all known targets. */
  targets?: readonly TargetId[];
  /** Description field for the generated plugin. */
  description?: string;
}

// ---------------------------------------------------------------------------
// Migrate

export interface MigrateOptions {
  /** When true, print planned changes without writing. Default: false. */
  dryRun?: boolean;
}

export interface MigrateResult {
  /**
   * Discriminant so consumers distinguish "ran and did nothing" from "ran and applied zero
   * of N" from "ran and failed." Retrofitting this later would be breaking.
   */
  status: 'no-migrations-needed' | 'applied' | 'failed';
  /** 0 in v0.1.0. */
  migrationsApplied: number;
  /** Absolute paths of files modified. */
  filesChanged: string[];
}

// ---------------------------------------------------------------------------
// Support

export interface SupportReport {
  plugin: string;
  /** Targets the plugin declares support for. */
  declared: TargetId[];
  /** Declared targets that are missing required artifacts. */
  missingArtifacts: { target: TargetId; missing: string[] }[];
  /** Targets not declared but plausibly addable, with the files the author would need. */
  suggestions: { target: TargetId; wouldNeed: string[] }[];
}
