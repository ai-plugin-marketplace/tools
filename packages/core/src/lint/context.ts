/**
 * {@link RuleContext} construction: the document cache and read-only workspace/envelope view
 * handed to every rule's `check()`.
 */

import * as fs from 'node:fs';
import type { AipmWorkspace } from '../config.js';
import type { ConfigCache } from '../pipeline/load-config.js';
import type { TargetId } from '../pipeline/types.js';
import { parseDocument, type Document } from './document.js';
import type { InternalRuleContext } from './types.js';

/**
 * Build an {@link InternalRuleContext} for a single plugin (or, for repo-scoped rules, the repo
 * root). Returns the internal-extended type (carrying `skipFreshness`/`configCache`) — every
 * caller in this package may pass the result to a `Rule.check()` that expects the narrower public
 * `RuleContext`, since `InternalRuleContext extends RuleContext`.
 */
export function createRuleContext(params: {
  pluginDir: string;
  repoRoot: string;
  distDir: string;
  envelope: readonly TargetId[];
  allPluginDirs?: readonly string[];
  workspace: AipmWorkspace | undefined;
  ci: boolean;
  skipFreshness?: boolean;
  configCache?: ConfigCache;
  /**
   * Shared across every `RuleContext` built for one `lint()` invocation. Every absolute path
   * successfully read via `getDocument()` (a real, readable file — L-D3's document layer) is
   * added here, regardless of parse outcome; this is `lint()`'s scan-scope record and backs the
   * `json` format's `summary.fileCount` (docs/specs/lint-engine.md §4.1). Callers that don't care
   * about scan tracking (most existing tests) may omit it — a throwaway `Set` is used instead.
   */
  scannedFiles?: Set<string>;
}): InternalRuleContext {
  const cache = new Map<string, Document | undefined>();
  const scannedFiles = params.scannedFiles ?? new Set<string>();
  return {
    pluginDir: params.pluginDir,
    repoRoot: params.repoRoot,
    distDir: params.distDir,
    envelope: params.envelope,
    allPluginDirs: params.allPluginDirs ?? [params.pluginDir],
    workspace: params.workspace,
    ci: params.ci,
    skipFreshness: params.skipFreshness ?? false,
    ...(params.configCache !== undefined ? { configCache: params.configCache } : {}),
    getDocument(absPath: string): Document | undefined {
      if (cache.has(absPath)) return cache.get(absPath);
      let doc: Document | undefined;
      try {
        const text = fs.readFileSync(absPath, 'utf-8');
        scannedFiles.add(absPath);
        doc = parseDocument(absPath, text);
      } catch {
        doc = undefined;
      }
      cache.set(absPath, doc);
      return doc;
    },
  };
}
