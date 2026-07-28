import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #534: a new page must not wait for the space tree.
//
// react-query awaits whatever a mutation's `onSuccess` RETURNS before it calls the caller's own
// onSuccess — and the sidebar's is where the navigation to the new page happens. `useCreatePage`
// returned `qc.invalidateQueries(...)`, so every click waited for the whole tree to refetch AND render
// first. Measured in a real browser at 200 pages: 1.6s to navigate, 2.0s to editable, with NO API call
// over 400ms (the server side was already 15ms). After: 0.12–0.25s to navigate, 517ms to editable warm.
//
// The pin is lexical because the property is about what that callback RETURNS, which is a fact about the
// source rather than about a rendered component (the same reasoning as the one-dispatch and
// destructive-guard checks). A behavioural test would need a rendered hook and would still not fail if
// someone re-introduced the return in a different mutation.
const SRC = readFileSync(resolve(import.meta.dirname, "queries.ts"), "utf8");

describe("#534 the new-page mutation does not block navigation", () => {
  it("useCreatePage's onSuccess does not return the invalidation promise", () => {
    const block = SRC.slice(SRC.indexOf("export function useCreatePage()"));
    const body = block.slice(0, block.indexOf("\n}\n"));
    const onSuccess = body.split("\n").find((l) => l.includes("onSuccess:"));
    expect(onSuccess, "useCreatePage still invalidates the tree").toBeTruthy();
    expect(onSuccess!, "…but must not hand react-query a promise to await — that is the 1.6s").toMatch(/=>\s*\{\s*void /);
  });

  it("the invalidation itself is still there (the tree must gain the new row)", () => {
    const block = SRC.slice(SRC.indexOf("export function useCreatePage()"));
    expect(block.slice(0, 2000)).toContain('invalidateQueries({ queryKey: ["pages", args.spaceId] })');
  });
});
