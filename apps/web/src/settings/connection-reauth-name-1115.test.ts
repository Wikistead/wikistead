// #1115 (owner ruling, #1045's review): the re-auth panel that replaces a connection's row
// while confirming a link/unlink asks "confirm it is you" and nothing else — the row it was about to
// act on disappears for the whole exchange. In a tenant with more than one connection, the reader
// loses track of WHICH one they are about to disconnect.
//
// Read from the SOURCE TEXT, not by rendering — same reasoning as connection-reauth-copy-1045.test.ts
// (no React component-render test exists in this package): the defect is specifically about whether
// the panel hands the shared form a NAMED prompt, which a locale-content check alone cannot see.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ConnectionsLinkPanel.tsx"), "utf8");

/** The `<RecoveryReauthForm ...>` opening tag's own text, not the whole file. */
function formTag(): string {
  const m = /<RecoveryReauthForm\b[\s\S]*?\/>/.exec(SRC);
  expect(m, "ConnectionsLinkPanel no longer renders RecoveryReauthForm — update this pin for whatever replaced it").not.toBeNull();
  return m![0];
}

describe("#1115: the reauth prompt names the connection it is about to act on", () => {
  it("the prompt prop passes a name — not a bare, unparameterised t() call", () => {
    const tag = formTag();
    const promptExpr = /\bprompt=\{([\s\S]*?)\}\s*(?:passkeyLabel|submitLabel)=/.exec(tag)?.[1];
    expect(promptExpr, "could not isolate the prompt={...} expression from the form tag").toBeTruthy();
    expect(promptExpr, "the prompt must be told which connection it is confirming (a `name` interpolation), not just t(key)")
      .toMatch(/\{\s*name\s*:/);
  });

  // ⚠️ break-check: the exact shape #1115 found — a bare t(key) call with no second argument, which
  // silently renders whatever the locale string says with no interpolation to fill.
  it("⚠️ break-check: a bare t(key) prompt (no name) is refused by the same match", () => {
    const bare = 'prompt={pendingAction === "unlink" ? t("account.connectionUnlinkReauthPrompt") : t("account.connectionLinkReauthPrompt")}';
    expect(bare).not.toMatch(/\{\s*name\s*:/);
  });

  it("en/ja: both reauth prompts carry a {{name}} placeholder for the interpolation to fill", () => {
    for (const key of ["connectionLinkReauthPrompt", "connectionUnlinkReauthPrompt"] as const) {
      expect(en.account[key], `en.account.${key}`).toContain("{{name}}");
      expect(ja.account[key], `ja.account.${key}`).toContain("{{name}}");
    }
  });
});
