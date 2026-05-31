import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import apiExtractorPlugin from '@api-extractor-tools/eslint-plugin';

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
      // Allow bracket notation for index-signature properties, which noPropertyAccessFromIndexSignature
      // in tsconfig.base.json requires. Without this override the stylistic-type-checked preset's
      // dot-notation rule would conflict with the TS compiler flag.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
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
  /**
   * API Extractor authoring-time feedback for the `@ai-plugin-marketplace/core` PUBLIC API only.
   * The public surface is `src/index.ts` plus the modules it re-exports (`config.ts`,
   * `pipeline/types.ts`, `pipeline/operations.ts`) — those are the symbols that reach the rolled-up
   * `.d.ts` and therefore need release tags. Internal modules (per-target code, pipeline internals,
   * test-support) are deliberately NOT part of the published surface (spec §8.1, §12.5), so the
   * release-tag rules must not apply to them. The `api:check` gate (API Extractor `--verify`)
   * backstops the actual rollup, so a forgotten tag on a newly-public symbol still fails CI.
   *
   * The `cli` package is an application (a `bin`, no public library API), so it has no setup here.
   *
   * The `recommended` config ships `plugins` + `rules` with no `files` key; we spread both into a
   * `files`-scoped block so the rules apply to the public-API sources only.
   */
  {
    files: [
      'packages/core/src/index.ts',
      'packages/core/src/config.ts',
      'packages/core/src/pipeline/types.ts',
      'packages/core/src/pipeline/operations.ts',
    ],
    plugins: apiExtractorPlugin.configs.recommended.plugins,
    rules: {
      ...apiExtractorPlugin.configs.recommended.rules,
      /**
       * `package-documentation` resolves the package entry point from `package.json`
       * (`main`/`types`/`exports`), all of which point into `dist/`. It therefore cannot map the
       * compiled entry back to `src/index.ts` and false-positives on the `@packageDocumentation`
       * comment that API Extractor itself requires on the source barrel. The rollup verifies the
       * tag is present and correct (see `dist/core.d.ts`), so disable the rule here rather than
       * carry a perpetual false-positive warning.
       */
      '@api-extractor-tools/package-documentation': 'off',
    },
  },
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
