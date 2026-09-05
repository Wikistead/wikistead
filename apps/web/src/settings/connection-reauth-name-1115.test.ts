// @vitest-environment happy-dom
// #1115 (owner ruling, #1045's review): the re-auth panel that replaces a connection's row
// while confirming a link/unlink asks "confirm it is you" and nothing else — the row it was about to
// act on disappears for the whole exchange. In a tenant with more than one connection, the reader
// loses track of WHICH one they are about to disconnect. The accepted fix is that the target's name
// shows in BOTH the method-chooser step and the proof-entry step (#1115's own acceptance).
//
// #1128 (review on this file): the first version here read ONLY source text, on the belief that
// this package has no React component-render test — false, `connection-name-required-834.test.ts`
// sits in this same directory. Worse, its own "⚠️ break-check" matched a string LITERAL it wrote
// itself, never the shipped file, so it could never go red no matter what the source said. The
// source-regex test below is kept (it is real — it reads ConnectionsLinkPanel.tsx and fails if the
// prompt prop stops naming the connection), but the render pin is what actually measures #1115's
// "both steps" acceptance criterion.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const { RecoveryReauthForm } = await import("./RecoveryCodesPanel");

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

  it("en/ja: both reauth prompts carry a {{name}} placeholder for the interpolation to fill", () => {
    for (const key of ["connectionLinkReauthPrompt", "connectionUnlinkReauthPrompt"] as const) {
      expect(en.account[key], `en.account.${key}`).toContain("{{name}}");
      expect(ja.account[key], `ja.account.${key}`).toContain("{{name}}");
    }
  });
});

describe("#1128: the named prompt actually renders, in EVERY re-auth step (not just the chooser)", () => {
  const NAMED_PROMPT = "confirm it is you: Acme SSO";

  function render(method: "totp" | "password" | "passkey" | null): { host: HTMLElement; unmount: () => void } {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(RecoveryReauthForm, {
        method, methods: ["totp", "password", "passkey"],
        proving: { code: "", password: "" },
        onChange: () => {}, onPick: () => {}, busy: false, passkeyBusy: false,
        onSubmit: () => {}, onPasskey: () => {}, onCancel: () => {},
        prompt: NAMED_PROMPT,
      }));
    });
    return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
  }

  for (const method of [null, "totp", "password", "passkey"] as const) {
    it(`step = ${method === null ? "chooser" : method}`, () => {
      const { host, unmount } = render(method);
      expect(host.querySelector('[data-testid="recovery-reauth-prompt"]')?.textContent, `the named prompt is missing in the ${method ?? "chooser"} step`)
        .toContain(NAMED_PROMPT);
      unmount();
    });
  }
});
