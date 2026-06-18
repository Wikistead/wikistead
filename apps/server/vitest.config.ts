import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Integration tests share a single DB instance — run files sequentially
    // to prevent concurrent state interference (e.g., space count races).
    fileParallelism: false,
  },
})
