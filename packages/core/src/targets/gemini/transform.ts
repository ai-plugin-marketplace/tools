/**
 * Pure mechanical transformations for the Gemini CLI target.
 *
 * Per spec §7.1, the transform layer is a pure function driven by a committed lookup table,
 * bounded to a single target. No I/O is performed here.
 *
 * @see docs/specs/architecture.md §7 (mechanical transformations)
 * @see docs/specs/architecture.md §12.4 (transform step + per-target folder layout)
 * @see docs/specs/architecture.md §12.5 (internal module shape)
 */

import type { GeminiToolName } from './schemas.js';

// ---------------------------------------------------------------------------
// Tool name lookup table
// ---------------------------------------------------------------------------

/**
 * Committed lookup table mapping Claude Code tool names (PascalCase) to Gemini CLI
 * tool names (snake_case). Per spec §7.1, the mechanical-transformation definition
 * requires the table be committed in source.
 *
 * Exact port of CLAUDE_TO_GEMINI_TOOLS from the template's build-standalone.ts.
 */
export const CLAUDE_TO_GEMINI_TOOLS: Readonly<Record<string, GeminiToolName>> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'replace',
  Glob: 'glob',
  Grep: 'search_file_content',
  Bash: 'run_shell_command',
  Agent: 'activate_skill',
};

// ---------------------------------------------------------------------------
// Single-tool translation
// ---------------------------------------------------------------------------

/**
 * Translate a single Claude Code tool name to its Gemini CLI equivalent.
 * Returns the Gemini tool name or `undefined` if there is no mapping.
 */
export function translateToolName(claudeToolName: string): GeminiToolName | undefined {
  return CLAUDE_TO_GEMINI_TOOLS[claudeToolName];
}

// ---------------------------------------------------------------------------
// Agent frontmatter rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite the `tools:` list in an agent `.md` file's YAML frontmatter from Claude Code
 * tool names to Gemini CLI equivalents. Tools with no mapping are dropped.
 *
 * Pure: takes a string, returns a string + metadata. No I/O.
 *
 * @param mdContent - Full content of the agent `.md` file.
 * @returns Rewritten content and the list of dropped Claude tool names (for diagnostics).
 */
export function rewriteAgentFrontmatterTools(mdContent: string): {
  content: string;
  droppedTools: string[];
} {
  const droppedTools: string[] = [];

  // Regex matches YAML frontmatter with a tools: block (exact port from build-standalone.ts)
  const rewritten = mdContent.replace(
    /^(---\n[\s\S]*?)(tools:\n)((?:\s+-\s+\S+\n)+)([\s\S]*?---)/m,
    (_match, before: string, toolsKey: string, toolsList: string, after: string) => {
      const translatedLines: string[] = [];

      for (const line of toolsList.split('\n')) {
        const toolMatch = /^\s+-\s+(\S+)/.exec(line);
        if (!toolMatch?.[1]) continue;

        const claudeTool = toolMatch[1];
        const geminiTool = CLAUDE_TO_GEMINI_TOOLS[claudeTool];

        if (geminiTool) {
          translatedLines.push(`  - ${geminiTool}`);
        } else {
          droppedTools.push(claudeTool);
        }
      }

      if (translatedLines.length === 0) {
        return `${before}tools: []\n${after}`;
      }

      return `${before}${toolsKey}${translatedLines.join('\n')}\n${after}`;
    },
  );

  return { content: rewritten, droppedTools };
}
