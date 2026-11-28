// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // The live checks drive Playwright, which isn't a project dependency.
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      'scripts/dev/firefox-check.mjs',
      'scripts/dev/live-check.mjs',
      'scripts/dev/inline-menu-check.mjs',
      'scripts/dev/write-check.mjs',
      'scripts/dev/passkey-check.mjs',
      'scripts/dev/form-fill-check.mjs',
      'scripts/dev/frame-fill-check.mjs',
      'scripts/dev/biometric-check.mjs',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } },
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // Never log vault data. Use the logger in src/shared/log.ts, which redacts by design.
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    // Dev scripts talk to a local server's JSON API; typing every response isn't worth it.
    files: ['scripts/dev/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // vi.mocked(obj.method) and expect.any() trip these in tests only.
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
