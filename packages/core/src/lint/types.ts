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
  /**
   * Load (and cache) the position-aware document at `absPath`. Format is inferred from the
   * extension (`.json` → JSON via `jsonc-parser`; `.yaml`/`.yml` → YAML CST; `.md` → frontmatter
   * extraction). Returns `undefined` when the file does not exist or cannot be parsed.
   */
  getDocument(absPath: string): Document | undefined;
}

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
}
