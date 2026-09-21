import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 30000, // in-memory mongo startup can be slow
    hookTimeout: 30000,
    setupFiles: ['./vitest.setup.js'],
  },
});
