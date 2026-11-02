import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test', APP_TZ: 'Europe/Rome' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: true,
  },
})
