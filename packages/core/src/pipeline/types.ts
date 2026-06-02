/**
 * Public types for the core API. These are the contract surface per §8.1 of the spec.
 */

/**
 * A host-platform identity. The closed union of target IDs this toolkit version knows about.
 *
 * Declared as an explicit literal union (matching the public contract in spec §8.1) rather than
 * derived from `TARGET_IDS`. This keeps the public type self-contained: a
 * `typeof TARGET_IDS` derivation would make the published `TargetId` depend on the non-exported
 * `TARGET_IDS` const, which API Extractor reports as `ae-forgotten-export`. The runtime array
 * below is validated against this union with `satisfies`, so the two cannot drift.
 *
 * @public
 */
export type TargetId = 'claude' | 'codex' | 'cursor' | 'gemini' | 'kiro' | 'vercel';

/**
 * Canonical list of target IDs known to this toolkit version. Runtime-exposed so
 * `listTargets()` and config validation share one source of truth.
 *
 * `as const satisfies readonly TargetId[]` preserves the literal tuple type (required by
 * `z.enum`) while guaranteeing every entry is a valid {@link TargetId}. The
 * `_targetIdsAreExhaustive` assertion below closes the other direction (every {@link TargetId}
 * appears here), so the union and the array cannot drift in either direction.
 *
 * Not part of the public API — `index.ts` re-exports only the `TargetId` type, not this runtime
 * array. Marked `@internal` so the release-tag lint rule is satisfied without widening the
 * public surface.
 *
 * @internal
 */
export const TARGET_IDS = [
  'claude',
  'codex',
  'cursor',
  'gemini',
  'kiro',
  'vercel',
] as const satisfies readonly TargetId[];

/**
 * Compile-time exhaustiveness guard: fails to typecheck if any {@link TargetId} member is missing
 * from `TARGET_IDS`. Combined with the `satisfies` above (which rejects extra/invalid entries),
 * this makes the union and the runtime array provably equivalent. Type-only — erased at compile
 * time, zero runtime cost.
 *
 * Declared as a `declare const` (rather than a bare `type` alias) so `noUnusedLocals` does not
 * flag it. The declaration is never emitted; it exists solely to keep the exhaustiveness check
 * reachable.
 *
 * @internal
 */
declare const _targetIdsAreExhaustive: TargetId extends (typeof TARGET_IDS)[number] ? true : never;

// ---------------------------------------------------------------------------
// Build

/**
 * Options for {@link build}.
 *
 * @public
 */
export interface BuildOptions {
  /** Abort after the first hard validation finding. Default: false. */
  failFast?: boolean;
}

/**
 * Result of building a single plugin. One entry per plugin built.
 *
 * @public
 */
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

/**
 * A file produced or verified by the build.
 *
 * @public
 */
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

/**
 * Options for {@link validate}.
 *
 * @public
 */
export interface ValidateOptions {
  /** When true, skip the freshness check (§10.5). Default: false. */
  skipFreshness?: boolean;
}

/**
 * Result of validating one or more plugins.
 *
 * @public
 */
export interface ValidationResult {
  findings: Finding[];
  /** True iff no hard findings were emitted. Soft findings do not flip this. */
  passed: boolean;
}

/**
 * Enumerated finding codes. Additive — new codes arrive in toolkit MINOR releases; removing
 * or renaming a code is MAJOR. Consumers SHOULD handle unknown codes gracefully.
 *
 * @public
 */
export type FindingCode =
  | 'envelope-invalid'
  | 'repo-config-invalid'
  | 'envelope-adherence'
  | 'schema-invalid'
  | 'name-consistency'
  | 'mcp-key-sync'
  | 'marketplace-registration'
  | 'freshness';

/**
 * A single validation finding.
 *
 * @public
 */
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

/**
 * Options for {@link scaffold}.
 *
 * @public
 */
export interface ScaffoldOptions {
  /** Targets to scaffold for. Defaults to all known targets. */
  targets?: readonly TargetId[];
  /** Description field for the generated plugin. */
  description?: string;
}

// ---------------------------------------------------------------------------
// Init

/**
 * Options for {@link init}.
 *
 * @public
 */
export interface InitOptions {
  /**
   * Repo name written into the generated `package.json`. Defaults to the basename of the target
   * directory.
   */
  name?: string;
}

// ---------------------------------------------------------------------------
// Migrate

/**
 * Options for {@link migrate}.
 *
 * @public
 */
export interface MigrateOptions {
  /** When true, print planned changes without writing. Default: false. */
  dryRun?: boolean;
}

/**
 * Result of running {@link migrate}.
 *
 * @public
 */
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

/**
 * Diagnostic report from {@link checkSupport} describing a plugin's support envelope.
 *
 * @public
 */
export interface SupportReport {
  plugin: string;
  /** Targets the plugin declares support for. */
  declared: TargetId[];
  /** Declared targets that are missing required artifacts. */
  missingArtifacts: { target: TargetId; missing: string[] }[];
  /** Targets not declared but plausibly addable, with the files the author would need. */
  suggestions: { target: TargetId; wouldNeed: string[] }[];
}
