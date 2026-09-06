import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Playwright specs live in tests/e2e but are not vitest suites —
    // they need the vite webServer + a browser, and run via
    // `pnpm exec playwright test` instead.
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environment: 'node',
  },
})
