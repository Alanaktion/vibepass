import { defineConfig } from 'vitest/config';

// Shared config. The extension build itself is driven by scripts/build.mjs, which runs
// one Vite build per entry point (popup, background, content) and writes the manifest.
export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  define: {
    __BROWSER__: JSON.stringify('chrome'),
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts', 'tests/setup-sdk.ts'],
    // The SDK's KDFs (600k PBKDF2 rounds, Argon2id) are slow by design.
    testTimeout: 20_000,
  },
});
