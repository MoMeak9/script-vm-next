import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['src/__tests__/runtime-mode.setup.ts'],
    include: ['src/**/*.test.ts', 'docs/**/*.test.mjs'],
    exclude: ['node_modules/**', 'dist/**', 'demo-dist/**'],
  },
})
