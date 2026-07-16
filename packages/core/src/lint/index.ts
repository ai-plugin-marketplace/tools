/** Public surface of the lint engine (spec §2, §4.1). */

export { lint } from './engine.js';
export type { Document, FrontmatterDocument, JsonDocument, YamlDocument } from './document.js';
export type {
  Diagnostic,
  Fix,
  LintOptions,
  LintResult,
  Position,
  Range,
  Rule,
  RuleContext,
} from './types.js';
