// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,

  // Type-aware rules. These are the reason ESLint is here at all: the ingestion
  // jobs in #2-#5 are async, and an unawaited database write inside a poll loop
  // typechecks cleanly while silently dropping rows. tsc cannot see that;
  // no-floating-promises can.
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are allowed when prefixed with _, which keeps interface
      // implementations readable without disabling the rule wholesale.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // node:test's describe/it return promises that callers are explicitly not
      // meant to await -- the runner handles them. Rather than switch the rule off
      // for test files, which would also stop it catching genuinely unawaited
      // database calls in tests, name those functions as known-safe and leave the
      // rule fully active everywhere else.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: [
                'after',
                'afterEach',
                'before',
                'beforeEach',
                'describe',
                'it',
                'suite',
                'test',
              ],
            },
          ],
        },
      ],
    },
  },

  // The eslint config file itself is not part of the TS project.
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
