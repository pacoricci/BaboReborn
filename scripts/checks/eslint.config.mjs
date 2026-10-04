import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'backend/web/dist/**',
      'backend/web/portal/**',
      'output/**',
      'frontend/src/network/generated/**',
      '.playwright-cli/**',
    ],
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-duplicate-imports': 'error' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './scripts/checks/typescript/tsconfig.eslint.json',
        tsconfigRootDir: root,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // One value and one type declaration per module, never inline type specifiers.
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportSpecifier[importKind='type']",
          message: 'Move type specifiers to a separate `import type` declaration.',
        },
      ],
    },
  },
);
