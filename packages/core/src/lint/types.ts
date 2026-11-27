/**
 * Core types for the position-aware lint engine.
 *
 * @see docs/specs/lint-engine.md L-D1 (Diagnostic), L-D4 (Rule)
 */

import type { AipmWorkspace } from '../config.js';
import type { ConfigCache } from '../pipeline/load-config.js';
import type { FindingCode, TargetId } from '../pipeline/types.js';
import type { Document } from './document.js';

/**
 * A 1-indexed source position. `line` and `col` both start at 1, matching editor conventions
 * (not 0-indexed offsets).
 *
 * @public
 */
export interface Position {
  line: number;
  col: number;
}

/**
 * A source range, 1-indexed, half-open in the sense that `end` marks the position immediately
 * after the last character the range covers (mirrors LSP `Range` semantics).
 *
 * @public
 */
export interface Range {
  start: Position;
  end: Position;
}

/**
 * Reserved for future auto-fix support (spec §1.3 non-goals: no auto-fix in v1). Not applied by
 * anything in this release; present so the {@link Diagnostic} shape is stable when fix
 * application lands.
 *
 * @public
 */
export interface Fix {
  /** Human-readable description of what the fix would do. */
  description: string;
}

/**
 * The engine's unit of output.
 *
 * @see docs/specs/lint-engine.md L-D1
 * @public
 */
export interface Diagnostic {
  /** e.g. 'correctness/broken-file-ref'. */
  ruleId: string;
  category: 'schema' | 'correctness' | 'security' | 'agent-ux' | 'portability';
  severity: 'error' | 'warn' | 'info';
  message: string;
  /** Repo-relative path. */
  file: string;
  /** 1-indexed. Optional only for diagnostics that are genuinely file-scoped (L-D1). */
  range?: Range;
  /** Generated per-rule docs page. */
  docsUrl: string;
  hint?: string;
  /** Reserved; not applied in v1. */
  fix?: Fix;
  /** Present when the rule migrates an existing `validate()` check (L-D2). */
  legacyCode?: FindingCode;
}

/**
 * Read-only context handed to a {@link Rule}'s `check()`. Exposes the parsed document set and
 * workspace model for the plugin currently under lint — rules never do their own file discovery
 * or parsing (L-D3, L-D4).
 *
 * @public
 */
export interface RuleContext {
  /** Absolute path to the plugin directory under lint. */
  readonly pluginDir: string;
  /** Absolute path to the repo root. */
  readonly repoRoot: string;
  /** Absolute path to the repo's dist output directory. */
  readonly distDir: string;
  /** The plugin's declared target envelope. */
  readonly envelope: readonly TargetId[];
  /**
   * Every plugin directory under the repo root (length 1 for single-plugin input, mirroring
   * `Discovery.pluginDirs`). Repo-scoped rules (registry/root-artifact freshness) need the whole
   * set; per-plugin rules ignore it.
   */
  readonly allPluginDirs: readonly string[];
  /** The repo's `aipm.workspace.ts`, when registry generation is opted in. */
  readonly workspace: AipmWorkspace | undefined;
  /** True when running in a CI context (affects freshness severity, L-D2/§10.2). */
  readonly ci: boolean;
  /**
   * Load (and cache) the position-aware document at `absPath`. Format is inferred from the
   * extension (`.json` → JSON via `jsonc-parser`; `.yaml`/`.yml` → YAML CST; `.md` → frontmatter
   * extraction). Returns `undefined` when the file does not exist, its extension is not a
   * recognized document format, or (frontmatter only) the file has no leading `---` block. A file
   * that exists and *is* a recognized format but fails to parse is NOT `undefined` — it is a
   * `Document` whose `value` is `undefined` and whose `parseError` is set.
   */
  getDocument(absPath: string): Document | undefined;
}

/**
 * Internal extension of {@link RuleContext} carrying implementation-only fields needed by the
 * legacy freshness/envelope-shape rules. Not part of the public `Rule` contract — L-D4 specifies
 * that `RuleContext` "exposes the parsed document set and workspace model read-only" — so this
 * type is never exported from the package's public surface (`lint/index.ts` / root `index.ts`).
 *
 * Rule modules that live in this package may type their `check()` parameter as
 * `InternalRuleContext` instead of the public `RuleContext`: because {@link Rule.check} is
 * declared with TypeScript method syntax (not a function-typed property), method parameters are
 * checked bivariantly, so a `check(ctx: InternalRuleContext)` implementation still satisfies the
 * public `Rule` interface even though `InternalRuleContext` is a strict extension of
 * `RuleContext`. `createRuleContext` (`context.ts`) is the only place that constructs one.
 */
export interface InternalRuleContext extends RuleContext {
  /**
   * True to skip drift-detection freshness findings (structural gates like
   * `single-artifact-host`/`root-artifact-collision` still run). Mirrors `ValidateOptions`'
   * `skipFreshness` — set only by `validate()`'s post-build re-validation; `lint()` never sets it.
   */
  readonly skipFreshness: boolean;
  /**
   * Optional per-invocation `aipm.config.ts` transpile memo (see `pipeline/load-config.ts`'s
   * `ConfigCache`), threaded through so repo-scoped freshness rules reuse the same cache
   * `validate()`'s orchestrator already warmed rather than re-transpiling every config.
   */
  readonly configCache?: ConfigCache;
}

/**
 * A discovery mode the engine can run rules under (spec §2.4). Only `'aipm-repo'` is implemented
 * by this issue's scope — the others are reserved so a `Rule`'s `appliesTo` can be authored now
 * without becoming a breaking change once foreign discovery modes land (a later issue).
 *
 * @see docs/specs/lint-engine.md L-D5, §2.4
 * @public
 */
export type DiscoveryMode =
  | 'aipm-repo'
  | 'claude-plugin'
  | 'open-plugins'
  | 'skills-dir'
  | 'claude-user-config';

/**
 * A rule module.
 *
 * @see docs/specs/lint-engine.md L-D4
 * @public
 */
export interface Rule {
  meta: {
    /** '<category>/<kebab-name>'. */
    id: string;
    category: Diagnostic['category'];
    defaultSeverity: 'error' | 'warn' | 'info' | 'off';
    /** One-liner, feeds generated docs. */
    description: string;
    /**
     * Which discovery modes (§2.4) run this rule. Cross-file/workspace-dependent rules (that
     * need the aipm workspace model — freshness, mcp-key-sync, marketplace-registration,
     * name-consistency) declare `['aipm-repo']`; content-only rules that need nothing beyond a
     * single file (schema/frontmatter/broken-file-ref/hook-shape rules) declare every mode whose
     * discovered unit could contain that file. The engine does not yet filter on this field
     * (only `aipm-repo` discovery exists) — it exists so the public `Rule` contract already
     * matches L-D4 and adding discovery modes later isn't a breaking API change.
     */
    appliesTo: DiscoveryMode[];
  };
  check(ctx: RuleContext): Diagnostic[] | Promise<Diagnostic[]>;
}

/**
 * Options for {@link lint}.
 *
 * @public
 */
export interface LintOptions {
  /** True when running in a CI context (affects freshness severity). Default: false. */
  ci?: boolean;
}

/**
 * Result of {@link lint}.
 *
 * @public
 */
export interface LintResult {
  diagnostics: Diagnostic[];
  /**
   * Repo-relative paths of every file the run actually read via the document layer
   * (`RuleContext.getDocument()`, L-D3), deduped and sorted. This is `lint()`'s scan-scope
   * record — the truthful source for the `json` format's `summary.fileCount`
   * (docs/specs/lint-engine.md §4.1). A file that exists on disk but that no active rule reads
   * (e.g. it's outside every rule's candidate-file list, or the plugin's envelope excludes the
   * target that owns it) is not counted — `fileCount` reflects what this run actually scanned,
   * not everything present on disk.
   */
  scannedFiles: readonly string[];
}
