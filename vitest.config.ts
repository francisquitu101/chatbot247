import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'supabase/functions/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
})
