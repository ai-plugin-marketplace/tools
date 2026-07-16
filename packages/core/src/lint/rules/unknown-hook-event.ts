/**
 * `correctness/unknown-hook-event` (§3.2, new rule) — hook event names in the authored
 * `hooks/claude.yaml` source that fall outside Claude Code's recognized event set
 * (`targets/claude/schemas.ts`'s `claudeHookEventSchema`).
 *
 * This is a real event-name check on the pre-build YAML source, distinct from the schema-level
 * check the build already applies when compiling to `hooks/claude.json` (that one rejects the
 * whole file with a generic Zod shape error; this one names the specific offending event key with
 * a range into the YAML source).
 */

import * as path from 'node:path';
import { claudeHookEventSchema } from '../../targets/claude/schemas.js';
import { rangeForPath } from '../document.js';
import type { Diagnostic, Rule, RuleContext } from '../types.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'correctness/unknown-hook-event';
const KNOWN_EVENTS: readonly string[] = claudeHookEventSchema.options;

export const unknownHookEventRule: Rule = {
  meta: {
    id: RULE_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description: "Hook event names in hooks/claude.yaml are within the host's recognized set.",
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
    for (const eventName of Object.keys(hooks)) {
      if (KNOWN_EVENTS.includes(eventName)) continue;
      const range = rangeForPath(doc, ['hooks', eventName]);
      const diagnostic: Diagnostic = {
        ruleId: RULE_ID,
        category: 'correctness',
        severity: 'error',
        message: `${rel}: unrecognized hook event '${eventName}'. Known events: ${KNOWN_EVENTS.join(', ')}.`,
        file: rel,
        docsUrl: docsUrlFor(RULE_ID),
        hint: `Rename '${eventName}' to one of: ${KNOWN_EVENTS.join(', ')}.`,
      };
      if (range !== undefined) diagnostic.range = range;
      diagnostics.push(diagnostic);
    }
    return diagnostics;
  },
};
