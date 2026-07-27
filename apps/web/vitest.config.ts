import { defineConfig } from "vitest/config";

// Web unit tests run in Node (no DOM needed) — currently the inline-comment anchor
// logic, which is pure Yjs. Component/DOM tests would add an environment later.
export default defineConfig({
  // #530: mirror the app's `@` alias (vite.config.ts) so a unit test can import a module that reaches the
  // shadcn components — without it, importing anything under src/components/ui fails to resolve `@/lib/utils`
  // and the whole test FILE errors out (which reads as "no tests", not as a failure worth chasing).
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
