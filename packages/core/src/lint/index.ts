/** Public surface of the lint engine (spec §2, §4.1). */

export { lint } from './engine.js';
export { registeredRuleIds } from './registered-rules.js';
export { applyRuleSeverityOverrides, unknownRuleOverrideDiagnostics } from './rule-overrides.js';
export type { RuleSeverityOverride } from './rule-overrides.js';
export type { Document, FrontmatterDocument, JsonDocument, YamlDocument } from './document.js';
export type {
  Diagnostic,
  DiscoveryMode,
  Fix,
  LintOptions,
  LintResult,
  Position,
  Range,
  Rule,
  RuleContext,
} from './types.js';
