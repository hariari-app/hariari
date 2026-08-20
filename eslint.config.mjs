import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const typescriptFiles = ['src/**/*.ts', 'tests/**/*.ts', '*.config.ts'];

export default defineConfig(
  {
    ignores: ['node_modules/**', 'out/**', 'dist/**', '**/*.js', '**/*.mjs', '**/*.cjs'],
  },
  {
    files: typescriptFiles,
    extends: [eslint.configs.recommended, tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // These entry points intentionally lazy-load optional or platform-specific runtime modules.
    name: 'runtime-lazy-require-baseline',
    files: ['src/main/index.ts', 'src/main/pty/pty-session.ts', 'src/main/updater/auto-updater.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
