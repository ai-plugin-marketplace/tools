/**
 * Mechanical transformations for the Kiro target.
 *
 * Per spec §7.1, this module is a pure function driven by a committed lookup
 * table, bounded to a single target. No I/O occurs here.
 *
 * @see docs/specs/architecture.md §7, §7.1, §12.4, §12.5
 */

import type { KiroAgentConfig, KiroToolName } from './schemas.js';

// ---------------------------------------------------------------------------
// Tool-name lookup table
// ---------------------------------------------------------------------------

/**
 * Committed lookup table mapping Claude Code tool names (PascalCase) to Kiro
 * tool names (lowercase). Per spec §7.1, the mechanical-transformation definition
 * requires the table be committed in source.
 *
 * Ported byte-for-byte from `CLAUDE_TO_KIRO_TOOLS` in build-standalone.ts of the
 * template repository.
 *
 * @see /Users/mnorth/Development/ai-plugin-marketplace-template/src/build-standalone.ts
 */
export const CLAUDE_TO_KIRO_TOOLS: Readonly<Record<string, KiroToolName>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'write',
  Glob: 'glob',
  Grep: 'grep',
  Bash: 'shell',
  Agent: 'delegate',
};

// ---------------------------------------------------------------------------
// Pure transformation functions
// ---------------------------------------------------------------------------

/**
 * Translate a single Claude tool name to a Kiro tool name. Returns `undefined`
 * for unknown names (not in the committed lookup table).
 */
export function translateToolName(claudeToolName: string): KiroToolName | undefined {
  return CLAUDE_TO_KIRO_TOOLS[claudeToolName];
}

/**
 * Translate a list of Claude tool names to Kiro tool names. Unknown tool names
 * are silently dropped. The result is deduplicated (preserving first-seen order).
 */
export function translateAgentTools(claudeTools: readonly string[]): KiroToolName[] {
  const seen = new Set<KiroToolName>();
  const result: KiroToolName[] = [];
  for (const tool of claudeTools) {
    const kiroTool = CLAUDE_TO_KIRO_TOOLS[tool];
    if (kiroTool !== undefined && !seen.has(kiroTool)) {
      seen.add(kiroTool);
      result.push(kiroTool);
    }
  }
  return result;
}

/**
 * Build a Kiro agent JSON config from the content of a Claude agent `.md` file.
 *
 * Parses the YAML frontmatter and body, then returns a fully-populated
 * `KiroAgentConfig` object. Matches the output of `buildKiroAgentJson` in
 * build-standalone.ts of the template repository.
 *
 * Pure — takes the raw file content string and a fallback name (typically
 * derived from the filename without extension). Returns `null` if the content
 * has no recognisable YAML frontmatter.
 *
 * Default values match the template reference implementation:
 *   - `mcpServers`: `{}`
 *   - `toolAliases`: `{}`
 *   - `allowedTools`: `[]`
 *   - `resources`: `[]`
 *   - `hooks`: `{}`
 *   - `toolsSettings`: `{}`
 *   - `includeMcpJson`: `true`
 *   - `model`: `null`
 */
export function buildKiroAgentConfig(
  agentMdContent: string,
  fallbackName: string,
): KiroAgentConfig | null {
  // Same regex as build-standalone.ts for parity.
  const fmMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(agentMdContent);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1] ?? '';
  const body = fmMatch[2] ?? '';

  const nameMatch = /^name:\s*(.+)$/m.exec(frontmatter);
  const descMatch = /^description:\s*(.+)$/m.exec(frontmatter);

  const claudeTools: string[] = [];
  const toolsBlockMatch = /^tools:\n((?:\s+-\s+\S+\n?)+)/m.exec(frontmatter);
  if (toolsBlockMatch?.[1]) {
    for (const line of toolsBlockMatch[1].split('\n')) {
      const toolMatch = /^\s+-\s+(\S+)/.exec(line);
      if (toolMatch?.[1]) {
        claudeTools.push(toolMatch[1]);
      }
    }
  }

  const tools = translateAgentTools(claudeTools);

  return {
    name: nameMatch?.[1] ?? fallbackName,
    description: descMatch?.[1] ?? '',
    prompt: body.trim(),
    mcpServers: {},
    tools,
    toolAliases: {},
    allowedTools: [],
    resources: [],
    hooks: {},
    toolsSettings: {},
    includeMcpJson: true,
    model: null,
  };
}
