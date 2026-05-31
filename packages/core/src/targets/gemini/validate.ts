/**
 * Per-target validators for the Gemini CLI target.
 *
 * Responsibilities per §13 Phase A:
 *   1. Agent tool-name translation warnings — soft `schema-invalid` findings for
 *      Claude tool names that have no Gemini equivalent.
 *   2. gemini-extension.json schema validation — hard `schema-invalid` finding if
 *      the file exists but fails Zod parse.
 *
 * What is NOT validated here:
 *   - Envelope adherence (cross-target concern).
 *   - Shared agents/ frontmatter shape (Claude validator owns that).
 *   - dist/gemini/ freshness (cross-target freshness check).
 *
 * @see docs/specs/architecture.md §10 (validation contract)
 * @see docs/specs/architecture.md §8.1 (Finding types)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { Finding } from '../../pipeline/types.js';
import { geminiExtensionManifestSchema } from './schemas.js';
import { CLAUDE_TO_GEMINI_TOOLS } from './transform.js';

// ---------------------------------------------------------------------------
// YAML frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Extract the YAML frontmatter block from a Markdown file's content.
 * Returns the parsed object or `undefined` if no frontmatter is present.
 */
function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content);
  if (!match?.[1]) return undefined;
  const parsed: unknown = parseYaml(match[1]);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Check: agent tool-name translation warnings
// ---------------------------------------------------------------------------

/**
 * For each `.md` file directly under `plugins/<name>/agents/`, parse the YAML
 * frontmatter `tools` array. Any Claude tool name that has no entry in
 * `CLAUDE_TO_GEMINI_TOOLS` produces a soft `schema-invalid` finding indicating
 * it will be dropped from the Gemini bundle.
 *
 * Per §10.2 soft findings do not flip `ValidationResult.passed`.
 */
function checkAgentToolTranslations(pluginDir: string, pluginName: string): Finding[] {
  const findings: Finding[] = [];
  const agentsDir = path.join(pluginDir, 'agents');

  if (!fs.existsSync(agentsDir)) return findings;

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const agentPath = path.join(agentsDir, entry.name);
    const content = fs.readFileSync(agentPath, 'utf-8');
    const frontmatter = parseFrontmatter(content);

    if (!frontmatter) continue;

    const tools = frontmatter['tools'];
    if (!Array.isArray(tools)) continue;

    const agentLabel = path.basename(entry.name, '.md');

    for (const tool of tools) {
      if (typeof tool !== 'string') continue;
      if (!(tool in CLAUDE_TO_GEMINI_TOOLS)) {
        findings.push({
          severity: 'soft',
          code: 'schema-invalid',
          plugin: pluginName,
          message: `agent '${agentLabel}' uses Claude tool '${tool}' which has no Gemini equivalent — it will be dropped from the Gemini bundle`,
          hint: `Remove '${tool}' from the agent's frontmatter tools list, or add a mapping in CLAUDE_TO_GEMINI_TOOLS if Gemini gains an equivalent tool.`,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Check: gemini-extension.json schema validation
// ---------------------------------------------------------------------------

/**
 * If `plugins/<name>/gemini-extension.json` exists, parse and validate it against
 * `geminiExtensionManifestSchema`. A parse failure produces a hard `schema-invalid`
 * finding. Absence of the file produces no finding (cross-target envelope-adherence
 * handles the missing-file case).
 */
function checkGeminiExtensionJson(pluginDir: string, pluginName: string): Finding[] {
  const manifestPath = path.join(pluginDir, 'gemini-extension.json');

  if (!fs.existsSync(manifestPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        severity: 'hard',
        code: 'schema-invalid',
        plugin: pluginName,
        message: `gemini-extension.json is not valid JSON: ${msg}`,
        hint: 'Ensure gemini-extension.json is valid JSON.',
      },
    ];
  }

  const result = geminiExtensionManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return [
      {
        severity: 'hard',
        code: 'schema-invalid',
        plugin: pluginName,
        message: `gemini-extension.json failed schema validation: ${issues}`,
        hint: 'Ensure gemini-extension.json has a required string "name" field.',
      },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run Gemini-specific validators against a plugin directory.
 *
 * `pluginDir` is the absolute path to a `plugins/<name>/` directory.
 * All findings use `plugin: path.basename(pluginDir)`.
 */
export function validateGeminiPlugin(pluginDir: string): Finding[] {
  const pluginName = path.basename(pluginDir);
  return [
    ...checkAgentToolTranslations(pluginDir, pluginName),
    ...checkGeminiExtensionJson(pluginDir, pluginName),
  ];
}
