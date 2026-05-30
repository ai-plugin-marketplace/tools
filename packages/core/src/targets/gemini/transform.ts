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

import { parse as parseYaml } from 'yaml';

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

// ---------------------------------------------------------------------------
// Hooks translation (Claude YAML → Gemini JSON)
// ---------------------------------------------------------------------------

/**
 * Minimal local type for a single hook entry (command runner).
 * Defined here rather than imported from claude/ to honour the cross-target-import
 * prohibition enforced by ESLint (§3.4).
 */
interface GeminiHookEntry {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

/**
 * Minimal local type for a single hook matcher block.
 */
interface GeminiHookMatcher {
  matcher?: string;
  description?: string;
  hooks?: GeminiHookEntry[];
  [key: string]: unknown;
}

/**
 * Minimal local type for the top-level hooks file object.
 * Mirrors the shape used by `build-hooks.ts` in the template repo — a plain
 * object whose optional `hooks` key maps event names to arrays of matchers.
 *
 * @see /Users/mnorth/Development/ai-plugin-marketplace-template/src/build-hooks.ts
 *      `HooksFile` interface (reference)
 */
interface GeminiHooksFile {
  hooks?: Record<string, GeminiHookMatcher[]>;
  [key: string]: unknown;
}

/**
 * Deep-clone a parsed hooks object and translate `matcher` tool-name strings from
 * Claude Code PascalCase names to Gemini CLI snake_case equivalents via
 * {@link CLAUDE_TO_GEMINI_TOOLS}.
 *
 * Matchers that have no entry in the table (e.g. glob patterns, non-tool identifiers)
 * are preserved unchanged — exact port of `translateHooksForGemini` in `build-hooks.ts`.
 *
 * Pure: no I/O, no side-effects. The input object is never mutated.
 *
 * @param source - Parsed hooks object (as returned by the `yaml` package's `parse`).
 * @returns A new hooks object with matcher strings translated for Gemini CLI.
 *
 * @see https://geminicli.com/docs/extensions/reference/ — Gemini CLI hooks format
 * @see /Users/mnorth/Development/ai-plugin-marketplace-template/src/build-hooks.ts
 *      `translateHooksForGemini` (reference implementation)
 */
export function translateHooksForGemini(source: GeminiHooksFile): GeminiHooksFile {
  const cloned = JSON.parse(JSON.stringify(source)) as GeminiHooksFile;
  const { hooks } = cloned;
  if (!hooks) return cloned;

  for (const event of Object.keys(hooks)) {
    const matchers = hooks[event];
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      if (typeof m.matcher === 'string') {
        const translated = CLAUDE_TO_GEMINI_TOOLS[m.matcher];
        if (translated !== undefined) {
          m.matcher = translated;
        }
      }
    }
  }

  return cloned;
}

/**
 * One-shot conversion: parse a `hooks/claude.yaml` string, translate all tool-name
 * matchers for Gemini CLI, and serialize as pretty-printed JSON.
 *
 * Output format: 2-space indent, trailing newline — byte-identical to the output of
 * `convertHookFile(hooksDir, yamlFile, "gemini")` in the template's `build-hooks.ts`.
 *
 * Pure: no I/O. Throws if the YAML is malformed.
 *
 * @param yamlContent - Raw YAML string (contents of `hooks/claude.yaml` or `.yml`).
 * @returns Pretty-printed JSON string with trailing newline.
 * @throws {Error} If the YAML is malformed.
 *
 * @see https://geminicli.com/docs/extensions/reference/ — Gemini CLI hooks format
 * @see /Users/mnorth/Development/ai-plugin-marketplace-template/src/build-hooks.ts
 *      `convertHookFile` (reference implementation, gemini branch)
 */
export function convertClaudeHooksYamlToGeminiJson(yamlContent: string): string {
  const parsed = parseYaml(yamlContent) as GeminiHooksFile;
  const translated = translateHooksForGemini(parsed);
  return JSON.stringify(translated, null, 2) + '\n';
}
