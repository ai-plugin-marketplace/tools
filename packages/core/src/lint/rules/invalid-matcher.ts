/**
 * `correctness/invalid-matcher` (§3.2, new rule) — hook `matcher` values in the authored
 * `hooks/claude.yaml` source that are not valid regular expressions.
 */

import * as path from 'node:path';
import { rangeForPath } from '../document.js';
import type { Diagnostic, Rule, RuleContext } from '../types.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'correctness/invalid-matcher';

/** True iff `pattern` is a valid input to the `RegExp` constructor. */
function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export const invalidMatcherRule: Rule = {
  meta: {
    id: RULE_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description: 'Hook matchers in hooks/claude.yaml are valid regular expressions.',
  },
  check(ctx: RuleContext): Diagnostic[] {
    const rel = 'hooks/claude.yaml';
    const absPath = path.join(ctx.pluginDir, rel);
    const doc = ctx.getDocument(absPath);
    if (doc?.value === undefined) return [];
    const value = doc.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    const hooks = (value as Record<string, unknown>)['hooks'];
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [];

    const diagnostics: Diagnostic[] = [];
    for (const [eventName, matchers] of Object.entries(hooks)) {
      if (!Array.isArray(matchers)) continue;
      matchers.forEach((matcherEntry, index) => {
        if (typeof matcherEntry !== 'object' || matcherEntry === null) return;
        const matcher = (matcherEntry as Record<string, unknown>)['matcher'];
        if (typeof matcher !== 'string') return;
        if (isValidRegex(matcher)) return;
        const nodePath = ['hooks', eventName, index, 'matcher'];
        const range = rangeForPath(doc, nodePath);
        const diagnostic: Diagnostic = {
          ruleId: RULE_ID,
          category: 'correctness',
          severity: 'error',
          message: `${rel}: hooks.${eventName}[${String(index)}].matcher '${matcher}' is not a valid regular expression.`,
          file: rel,
          docsUrl: docsUrlFor(RULE_ID),
          hint: 'Fix the matcher so it is a valid JavaScript regular expression, or remove it to match all tool calls.',
        };
        if (range !== undefined) diagnostic.range = range;
        diagnostics.push(diagnostic);
      });
    }
    return diagnostics;
  },
};
