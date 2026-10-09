import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      ignored: ['**/public/cursors/**'],
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['supabase/**', 'node_modules/**', 'dist/**'],
  },
})
