/**
 * POSIX `sh` single-quote escaping — a primitive shared across generated-script emitters that
 * embed arbitrary string values into `sh` source.
 *
 * This module is a **neutral home**, not owned by any single generated-script concern:
 * `hooks/payload-adapter.ts` (a cross-harness concern, deliberately not under `targets/**`) and
 * `targets/cursor/transform.ts` (bound to a single target, per §3.4 no cross-target imports) both
 * need the identical `sh` single-quote primitive, but neither may import from the other.
 *
 * @see docs/specs/payload-adapter.md (payload-adapter's use: escaping the `--schema` JSON body)
 * @see docs/specs/cursor-controller-shim.md §3.1 (cursor transform's use: quoting a handler
 *   command as one shell token)
 */

/**
 * Escape a string for embedding inside a POSIX `sh` single-quoted literal: every `'` becomes
 * `'\''` (end the quote, an escaped literal quote, resume the quote) — the standard POSIX
 * technique, since `sh` single quotes have no escape character of their own.
 *
 * This does NOT wrap the result in quotes; the caller splices it between its own `'...'`
 * delimiters (or use {@link posixSingleQuote} to get a fully-quoted token).
 */
export function escapeForShSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

/**
 * POSIX-single-quote a string so it survives a shell's tokenization as a **single** argument:
 * wraps the whole string in single quotes, escaping any embedded single quote via
 * {@link escapeForShSingleQuotes}.
 */
export function posixSingleQuote(value: string): string {
  return `'${escapeForShSingleQuotes(value)}'`;
}
