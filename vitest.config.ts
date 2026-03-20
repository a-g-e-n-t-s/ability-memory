import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests connect to a remote broker, load vault secrets,
    // and register schemas — give hooks and tests generous timeouts.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
