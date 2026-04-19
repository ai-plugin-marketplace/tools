import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const TARGETS = ['claude', 'cursor', 'gemini', 'kiro', 'vercel'];

/**
 * Forbid cross-target imports inside core/src/targets/<X>/ from any sibling core/src/targets/<Y>/.
 * Enforced per §3.4 and §12.4 of the architecture spec. The architecture depends on this for
 * the future-splittable-into-per-target-packages claim in §8.3.
 *
 * `no-restricted-imports` matches the literal import string, not resolved paths. Inside
 * `targets/<X>/...`, a cross-target import is spelled either:
 *   - `../<sibling>` or `../<sibling>/...` (sibling at same depth)
 *   - `../../<X>/../../<Y>` or similar — covered by the same relative-parent prefix
 *   - `../../targets/<sibling>/...` (from deeper files)
 */
const perTargetIsolation = TARGETS.map((target) => {
  const forbiddenSiblings = TARGETS.filter((t) => t !== target);
  return {
    files: [`packages/core/src/targets/${target}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: forbiddenSiblings.flatMap((sibling) => [
            `../${sibling}`,
            `../${sibling}/**`,
            `../../**/targets/${sibling}`,
            `../../**/targets/${sibling}/**`,
          ]),
        },
      ],
    },
  };
});

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-plusplus': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  ...perTargetIsolation,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.config.mjs',
      '**/*.config.js',
      '**/*.config.ts',
      'docs/**',
    ],
  },
  prettier,
);
