import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors apps/web/vite.config.ts's alias — that config isn't otherwise
  // shared with this root-level test config.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './apps/web/src'),
    },
  },
  test: {
    include: ['apps/*/src/**/*.test.{ts,tsx}'],
    // Backend tests hit a real (in-memory) SQLite DB and don't need a DOM;
    // frontend component tests do. Most files are backend, so 'node' is the
    // default — component test files opt into jsdom individually via a
    // `// @vitest-environment jsdom` docblock at the top of the file.
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Report only — deliberately no threshold gate. An enforced floor on a
    // suite this young pushes toward tests written to raise a number rather
    // than the regression-driven ones this repo actually writes. Run with
    // `pnpm test:coverage` to see where the gaps are.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        'apps/*/src/**/*.test.{ts,tsx}',
        'apps/web/src/components/ui/**', // vendored shadcn
        'apps/bff/src/scripts/**', // one-shot CLI scripts, run by hand
        'apps/web/src/main.tsx',
      ],
    },
  },
});
