import { defineConfig } from 'vitest/config';

// Unit tests cover the pure business logic (pricing, validation, state machine, coupons...).
// They intentionally do not boot Nest, so no decorator-metadata transform is required.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    globals: false,
  },
});
