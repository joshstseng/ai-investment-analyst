import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'data/**', 'packages/db/drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // noUncheckedIndexedAccess types every array index and regex capture as possibly
      // undefined; `!` is how we state "the regex matched, so group 1 exists". Keep it allowed.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
