import { defineConfig } from "vitest/config";

// Web unit tests run in Node (no DOM needed) — currently the inline-comment anchor
// logic, which is pure Yjs. Component/DOM tests would add an environment later.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
