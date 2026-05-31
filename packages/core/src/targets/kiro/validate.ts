/**
 * Per-target validators for the Kiro target.
 *
 * Responsibilities (v0.1.0):
 *   1. POWER.md frontmatter — parse YAML and validate against
 *      `kiroPowerMdFrontmatterSchema`. Missing block or missing required fields
 *      → hard `schema-invalid`.
 *   2. POWER.md name-consistency — frontmatter `name` must match
 *      `path.basename(pluginDir)` → hard `name-consistency`.
 *   3. mcp.json schema — parse JSON and validate against `kiroMcpConfigSchema`
 *      → hard `schema-invalid`.
 *   4. Agent tool-name warnings — for each `.md` under `agents/` (one level),
 *      each tool not in `CLAUDE_TO_KIRO_TOOLS` → soft `schema-invalid`.
 *
 * What NOT validated here:
 *   - `.kiro/agents/<name>.json` (generated output — validated at bundle time)
 *   - Envelope adherence, marketplace registration, cross-target consistency
 *   - Shared agent .md shape beyond tool names (Claude validator owns frontmatter)
 *
 * Cross-target imports are forbidden per §3.4 of the architecture spec.
 *
 * @see docs/specs/architecture.md §10 (validation contract), §8.1 (Finding types)
 * @see docs/specs/architecture.md §12.5 (internal module shape), §3.4 (target isolation)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { Finding } from '../../pipeline/types.js';
import { CLAUDE_TO_KIRO_TOOLS } from './transform.js';
import { kiroMcpConfigSchema, kiroPowerMdFrontmatterSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a hard `schema-invalid` Finding scoped to `pluginName`. */
function hardSchemaFinding(pluginName: string, message: string, hint?: string): Finding {
  const finding: Finding = {
    severity: 'hard',
    code: 'schema-invalid',
    plugin: pluginName,
    message,
  };
  if (hint !== undefined) {
    finding.hint = hint;
  }
  return finding;
}

/** Build a hard `name-consistency` Finding scoped to `pluginName`. */
function hardNameFinding(pluginName: string, message: string, hint?: string): Finding {
  const finding: Finding = {
    severity: 'hard',
    code: 'name-consistency',
    plugin: pluginName,
    message,
  };
  if (hint !== undefined) {
    finding.hint = hint;
  }
  return finding;
}

/** Build a soft `schema-invalid` Finding scoped to `pluginName`. */
function softSchemaFinding(pluginName: string, message: string, hint?: string): Finding {
  const finding: Finding = {
    severity: 'soft',
    code: 'schema-invalid',
    plugin: pluginName,
    message,
  };
  if (hint !== undefined) {
    finding.hint = hint;
  }
  return finding;
}

// ---------------------------------------------------------------------------
// POWER.md validation
// ---------------------------------------------------------------------------

/**
 * Validate POWER.md frontmatter:
 *   - Parse YAML between `---` markers.
 *   - Validate against `kiroPowerMdFrontmatterSchema`.
 *   - Verify `name` matches `path.basename(pluginDir)`.
 *
 * Returns zero findings when POWER.md is absent (envelope-adherence owns that check).
 */
function validatePowerMd(pluginDir: string, pluginName: string): Finding[] {
  const powerMdPath = path.join(pluginDir, 'POWER.md');
  if (!fs.existsSync(powerMdPath)) return [];

  const content = fs.readFileSync(powerMdPath, 'utf-8');

  // Extract frontmatter block between leading `---` markers.
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content);
  if (fmMatch === null) {
    return [
      hardSchemaFinding(
        pluginName,
        `POWER.md has no frontmatter block`,
        `add a YAML frontmatter block between --- markers at the top of POWER.md with required fields: name, description, version`,
      ),
    ];
  }

  const frontmatterYaml = fmMatch[1] ?? '';
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterYaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      hardSchemaFinding(
        pluginName,
        `POWER.md frontmatter YAML parse error: ${msg}`,
        `fix the YAML syntax in the POWER.md frontmatter`,
      ),
    ];
  }

  const result = kiroPowerMdFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return [
      hardSchemaFinding(
        pluginName,
        `POWER.md frontmatter does not match schema — ${issues}`,
        `ensure POWER.md frontmatter includes required fields: name, description, version`,
      ),
    ];
  }

  // Name-consistency check: frontmatter name must match the plugin directory name.
  const frontmatterName = result.data.name;
  if (frontmatterName !== pluginName) {
    return [
      hardNameFinding(
        pluginName,
        `POWER.md frontmatter name '${frontmatterName}' does not match plugin directory '${pluginName}'`,
        `set the name field in POWER.md frontmatter to '${pluginName}'`,
      ),
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// mcp.json validation
// ---------------------------------------------------------------------------

/**
 * If `mcp.json` exists, parse JSON and validate against `kiroMcpConfigSchema`.
 * Missing file → no finding (envelope-adherence owns that check).
 */
function validateMcpJson(pluginDir: string, pluginName: string): Finding[] {
  const mcpPath = path.join(pluginDir, 'mcp.json');
  if (!fs.existsSync(mcpPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as unknown;
  } catch {
    return [
      hardSchemaFinding(
        pluginName,
        `mcp.json is not valid JSON`,
        `fix the JSON syntax in mcp.json`,
      ),
    ];
  }

  const result = kiroMcpConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return [
      hardSchemaFinding(
        pluginName,
        `mcp.json does not match the Kiro MCP config schema — ${issues}`,
        `ensure mcp.json has the shape { mcpServers: Record<string, { command: string, args?: string[], env?: Record<string, string> }> }`,
      ),
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Agent tool-name translation warnings
// ---------------------------------------------------------------------------

/**
 * Extract the `tools` array from YAML frontmatter of a `.md` file.
 * Returns an empty array if the file has no frontmatter or no `tools` field.
 * Parse errors are silently ignored (the Claude validator owns frontmatter shape).
 */
function extractAgentTools(content: string): string[] {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content);
  if (fmMatch === null) return [];

  const frontmatterYaml = fmMatch[1] ?? '';
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterYaml);
  } catch {
    return [];
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('tools' in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>)['tools'])
  ) {
    return [];
  }

  const tools = (parsed as Record<string, unknown>)['tools'] as unknown[];
  return tools.filter((t): t is string => typeof t === 'string');
}

/**
 * For each `.md` file directly under `agents/` (one level deep), emit a soft
 * `schema-invalid` finding for each tool name not present in `CLAUDE_TO_KIRO_TOOLS`.
 *
 * Severity is soft — unmapped tools are dropped from the Kiro bundle but do not
 * block the build.
 */
function validateAgentToolNames(pluginDir: string, pluginName: string): Finding[] {
  const agentsDir = path.join(pluginDir, 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  const findings: Finding[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const agentName = entry.name.replace(/\.md$/, '');
    const agentPath = path.join(agentsDir, entry.name);
    const content = fs.readFileSync(agentPath, 'utf-8');
    const tools = extractAgentTools(content);

    for (const tool of tools) {
      if (!(tool in CLAUDE_TO_KIRO_TOOLS)) {
        findings.push(
          softSchemaFinding(
            pluginName,
            `agent '${agentName}' uses Claude tool '${tool}' which has no Kiro equivalent — it will be dropped from the Kiro bundle`,
            `remove '${tool}' from the tools list in agents/${entry.name}, or check the CLAUDE_TO_KIRO_TOOLS table for the correct Claude tool name`,
          ),
        );
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run Kiro-specific validators against a plugin directory.
 *
 * `pluginDir` is the absolute path to a `plugins/<name>/` directory.
 * All findings use `plugin: path.basename(pluginDir)`.
 *
 * Returns zero or more Findings. Callers combine these with other targets'
 * findings and the cross-target findings in the pipeline validator.
 */
export function validateKiroPlugin(pluginDir: string): Finding[] {
  const pluginName = path.basename(pluginDir);

  return [
    ...validatePowerMd(pluginDir, pluginName),
    ...validateMcpJson(pluginDir, pluginName),
    ...validateAgentToolNames(pluginDir, pluginName),
  ];
}
