import { defineConfig } from 'vitest/config';

// Own config so vitest does not pick up the gateway's root vitest.config.ts
// (whose dependencies are not installed when only clients/js is set up).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
