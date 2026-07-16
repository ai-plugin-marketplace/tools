/**
 * {@link RuleContext} construction: the document cache and read-only workspace/envelope view
 * handed to every rule's `check()`.
 */

import * as fs from 'node:fs';
import type { AipmWorkspace } from '../config.js';
import type { ConfigCache } from '../pipeline/load-config.js';
import type { TargetId } from '../pipeline/types.js';
import { parseDocument, type Document } from './document.js';
import type { RuleContext } from './types.js';

/** Build a {@link RuleContext} for a single plugin (or, for repo-scoped rules, the repo root). */
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
}): RuleContext {
  const cache = new Map<string, Document | undefined>();
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
        doc = parseDocument(absPath, text);
      } catch {
        doc = undefined;
      }
      cache.set(absPath, doc);
      return doc;
    },
  };
}
