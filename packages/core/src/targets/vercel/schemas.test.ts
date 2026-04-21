/**
 * Tests for vercelSkillFrontmatterSchema.
 *
 * Constraints are sourced from `validateSkillFrontmatter` in the template repo
 * (`src/validate.ts`) which implements the agentskills.io spec.
 *
 * @see https://agentskills.io
 */

import { describe, expect, it } from 'vitest';

import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  vercelSkillFrontmatterSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passes(input: unknown): boolean {
  return vercelSkillFrontmatterSchema.safeParse(input).success;
}

function fails(input: unknown): boolean {
  return !passes(input);
}

// ---------------------------------------------------------------------------
// Positive tests
// ---------------------------------------------------------------------------

describe('vercelSkillFrontmatterSchema — positive cases', () => {
  it('accepts a realistic example from skill-evaluator', () => {
    // Matches the frontmatter of plugins/skill-evaluator/skills/evaluate-skill/SKILL.md
    // in the template repo.
    const result = vercelSkillFrontmatterSchema.safeParse({
      name: 'evaluate-skill',
      description: 'Evaluate an AI skill across model tiers using blind sub-agent testing',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('evaluate-skill');
      expect(result.data.description).toBe(
        'Evaluate an AI skill across model tiers using blind sub-agent testing',
      );
    }
  });

  it('accepts schemaVersion: "0.1.0" alongside required fields (§9.4 / §12.2)', () => {
    expect(
      passes({
        schemaVersion: '0.1.0',
        name: 'my-skill',
        description: 'A valid description.',
      }),
    ).toBe(true);
  });

  it('accepts extra platform-specific keys without rejection (.loose() behavior)', () => {
    // Claude, Cursor, Gemini, and Kiro may add their own keys to SKILL.md frontmatter.
    expect(
      passes({
        name: 'my-skill',
        description: 'A valid description.',
        model: 'sonnet',
        tools: ['read', 'write'],
        color: '#ff6600',
      }),
    ).toBe(true);
  });

  it('accepts a name that is exactly 64 characters (boundary)', () => {
    // 'a' + 63 × 'b' = 64 chars
    const name = 'a' + 'b'.repeat(63);
    expect(name).toHaveLength(SKILL_NAME_MAX_LENGTH);
    expect(passes({ name, description: 'Valid.' })).toBe(true);
  });

  it('accepts a description that is exactly 1024 characters (boundary)', () => {
    const description = 'a'.repeat(SKILL_DESCRIPTION_MAX_LENGTH);
    expect(passes({ name: 'my-skill', description })).toBe(true);
  });

  it('accepts a single-letter name', () => {
    expect(passes({ name: 'a', description: 'Valid.' })).toBe(true);
  });

  it('accepts a name with digits after the leading letter', () => {
    expect(passes({ name: 'skill123', description: 'Valid.' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative tests — missing required fields
// ---------------------------------------------------------------------------

describe('vercelSkillFrontmatterSchema — missing required fields', () => {
  it('rejects when name is missing', () => {
    expect(fails({ description: 'A description.' })).toBe(true);
  });

  it('rejects when description is missing', () => {
    expect(fails({ name: 'my-skill' })).toBe(true);
  });

  it('rejects when both name and description are missing', () => {
    expect(fails({})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative tests — name constraints
// ---------------------------------------------------------------------------

describe('vercelSkillFrontmatterSchema — name constraint violations', () => {
  it('rejects a name exceeding 64 characters', () => {
    // 'a' + 64 × 'b' = 65 chars
    const name = 'a' + 'b'.repeat(64);
    expect(name.length).toBeGreaterThan(SKILL_NAME_MAX_LENGTH);
    expect(fails({ name, description: 'Valid.' })).toBe(true);
  });

  it('rejects a name containing uppercase letters', () => {
    expect(fails({ name: 'MySkill', description: 'Valid.' })).toBe(true);
  });

  it('rejects a name starting with a digit', () => {
    expect(fails({ name: '1skill', description: 'Valid.' })).toBe(true);
  });

  it('rejects a name with consecutive hyphens (foo--bar)', () => {
    expect(fails({ name: 'foo--bar', description: 'Valid.' })).toBe(true);
  });

  it('rejects a name ending with a hyphen (foo-)', () => {
    expect(fails({ name: 'foo-', description: 'Valid.' })).toBe(true);
  });

  it('rejects a name containing spaces', () => {
    expect(fails({ name: 'my skill', description: 'Valid.' })).toBe(true);
  });

  it('rejects a name containing underscores', () => {
    expect(fails({ name: 'my_skill', description: 'Valid.' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative tests — description constraints
// ---------------------------------------------------------------------------

describe('vercelSkillFrontmatterSchema — description constraint violations', () => {
  it('rejects an empty description', () => {
    expect(fails({ name: 'my-skill', description: '' })).toBe(true);
  });

  it('rejects a description exceeding 1024 characters', () => {
    const description = 'a'.repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1);
    expect(description.length).toBeGreaterThan(SKILL_DESCRIPTION_MAX_LENGTH);
    expect(fails({ name: 'my-skill', description })).toBe(true);
  });
});
