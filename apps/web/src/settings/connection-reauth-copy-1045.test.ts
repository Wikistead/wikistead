// #1045 (review c-aead6c7, review bounce): ConnectionsLinkPanel reuses
// RecoveryReauthForm — RecoveryCodesPanel's "confirm it is you" step — for BOTH linking and
// unlinking a sign-in method. The form's default copy names what RecoveryCodesPanel does with the
// proof ("Create recovery codes"); unwired, a member disconnecting a sign-in method would commit
// with a button reading exactly that — a destructive action behind an unrelated, harmless-sounding
// label.
//
// Read from the SOURCE TEXT, not by rendering: this codebase has no React component-render test
// anywhere (checked — no `.test.tsx` file exists), and the defect this pins is specifically about
// what JSX prop the panel PASSES the shared form, which a locale-content check alone (i18n keys
// existing and reading correctly) cannot see — the panel could still hand the form nothing and fall
// through to the wrong default.
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

describe("#1045: the shared reauth form is told which action it is confirming, not left on its defaults", () => {
  it("passes submitLabel — without it, the button falls back to RecoveryCodesPanel's own label", () => {
    expect(formTag()).toMatch(/\bsubmitLabel=/);
  });
  it("passes prompt — without it, the sentence above the form claims codes are about to be created", () => {
    expect(formTag()).toMatch(/\bprompt=/);
  });
  it("passes passkeyLabel — the passkey button is a separate branch of the form with its own default", () => {
    expect(formTag()).toMatch(/\bpasskeyLabel=/);
  });

  // ⚠️ break-check: prove the regex actually rejects the exact shape #1045 found — the form rendered
  // with no override props at all, which is what silently falls through to "Create recovery codes".
  it("⚠️ break-check: a bare, unlabelled RecoveryReauthForm tag is refused, not silently passed", () => {
    const bare = '<RecoveryReauthForm method={method} methods={methods} proving={proving} onChange={setProving} />';
    expect(bare).not.toMatch(/\bsubmitLabel=/);
  });

  it("en: the unlink submit/prompt/passkey copy actually differs from the link/recovery-code copy", () => {
    expect(en.account.connectionUnlinkButton, "unlink submit label").not.toBe(en.account.recoveryMint);
    expect(en.account.connectionUnlinkButton).not.toBe(en.account.connectionLinkButton);
    expect(en.account.connectionUnlinkReauthPrompt, "unlink prompt").not.toBe(en.account.recoveryReauthPrompt);
    expect(en.account.connectionUnlinkReauthPasskey, "unlink passkey label").not.toBe(en.account.recoveryReauthPasskey);
  });
  it("ja: the unlink submit/prompt/passkey copy actually differs from the link/recovery-code copy", () => {
    expect(ja.account.connectionUnlinkButton, "unlink submit label").not.toBe(ja.account.recoveryMint);
    expect(ja.account.connectionUnlinkButton).not.toBe(ja.account.connectionLinkButton);
    expect(ja.account.connectionUnlinkReauthPrompt, "unlink prompt").not.toBe(ja.account.recoveryReauthPrompt);
    expect(ja.account.connectionUnlinkReauthPasskey, "unlink passkey label").not.toBe(ja.account.recoveryReauthPasskey);
  });
});
