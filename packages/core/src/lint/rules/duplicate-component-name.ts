/**
 * `correctness/duplicate-component-name` (§3.2, new rule) — colliding skill/agent/command names
 * within a unit (a plugin). Checked independently within each of the three component kinds
 * (two skills sharing a name is a collision; a skill and an agent sharing a name is not — they
 * are installed into distinct namespaces).
 *
 * A component's name is its frontmatter `name` field when present (the authored identity used by
 * the host), falling back to the directory/file basename when frontmatter carries no `name` (the
 * effective identity a host would key on regardless).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { rangeForPath } from '../document.js';
import type { Diagnostic, Rule, RuleContext } from '../types.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'correctness/duplicate-component-name';

interface ComponentEntry {
  /** Repo-relative-to-plugin path, e.g. 'skills/foo/SKILL.md'. */
  rel: string;
  name: string;
}

/** Resolve a component's effective name: frontmatter `name` field, else the fallback basename. */
function resolveName(
  ctx: RuleContext,
  rel: string,
  fallback: string,
): { name: string; hasNameField: boolean } {
  const absPath = path.join(ctx.pluginDir, rel);
  const doc = ctx.getDocument(absPath);
  const value = doc?.value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const name = (value as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.length > 0) return { name, hasNameField: true };
  }
  return { name: fallback, hasNameField: false };
}

function collectSkills(ctx: RuleContext): ComponentEntry[] {
  const skillsDir = path.join(ctx.pluginDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  const out: ComponentEntry[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `skills/${entry.name}/SKILL.md`;
    if (!fs.existsSync(path.join(ctx.pluginDir, rel))) continue;
    out.push({ rel, ...resolveName(ctx, rel, entry.name) });
  }
  return out;
}

function collectFlatMarkdown(ctx: RuleContext, sub: 'agents' | 'commands'): ComponentEntry[] {
  const dir = path.join(ctx.pluginDir, sub);
  if (!fs.existsSync(dir)) return [];
  const out: ComponentEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const rel = `${sub}/${entry.name}`;
    const fallback = entry.name.slice(0, -'.md'.length);
    out.push({ rel, ...resolveName(ctx, rel, fallback) });
  }
  return out;
}

function reportDuplicates(ctx: RuleContext, kind: string, entries: ComponentEntry[]): Diagnostic[] {
  const byName = new Map<string, ComponentEntry[]>();
  for (const entry of entries) {
    const group = byName.get(entry.name) ?? [];
    group.push(entry);
    byName.set(entry.name, group);
  }

  const diagnostics: Diagnostic[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    for (const entry of group) {
      const others = group.filter((e) => e !== entry).map((e) => e.rel);
      const doc = ctx.getDocument(path.join(ctx.pluginDir, entry.rel));
      const range = doc !== undefined ? rangeForPath(doc, ['name']) : undefined;
      diagnostics.push({
        ruleId: RULE_ID,
        category: 'correctness',
        severity: 'error',
        message: `${entry.rel}: ${kind} name '${name}' collides with ${others.join(', ')}.`,
        file: entry.rel,
        docsUrl: docsUrlFor(RULE_ID),
        hint: `Rename this ${kind} (or the others) so every ${kind} name is unique within the plugin.`,
        ...(range !== undefined ? { range } : {}),
      });
    }
  }
  return diagnostics;
}

export const duplicateComponentNameRule: Rule = {
  meta: {
    id: RULE_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description: 'No two skills (or agents, or commands) within a plugin share the same name.',
  },
  check(ctx: RuleContext): Diagnostic[] {
    return [
      ...reportDuplicates(ctx, 'skill', collectSkills(ctx)),
      ...reportDuplicates(ctx, 'agent', collectFlatMarkdown(ctx, 'agents')),
      ...reportDuplicates(ctx, 'command', collectFlatMarkdown(ctx, 'commands')),
    ];
  },
};
