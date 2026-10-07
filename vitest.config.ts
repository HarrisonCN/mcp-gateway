import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index.ts only re-exports; cli.ts is exercised end-to-end in a child
      // process (test/cli.test.ts), which v8 coverage cannot see.
      exclude: ['src/index.ts', 'src/cli.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      // Ratchet: raise these as coverage improves, never lower them.
      thresholds: {
        statements: 90,
        branches: 78,
        functions: 90,
        lines: 90,
      },
    },
  },
});
