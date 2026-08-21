// @vitest-environment happy-dom
//
// ⚠️ The environment is not decoration: `routes.tsx` resolves the collaboration URL at module scope
// from `window.location`, so importing it at all needs a document. Reading the file as text instead
// (the shape a few neighbours use) would measure the source rather than the shipped function.
// #806: the closed door gets its own sentence, and it is not the server's.
//
// Making signup answer 404 when the deployment declares no workspace address created a state the
// screen had never been in: a person who signed in through the identity provider, reached "Name your
// workspace", and pressed the button. What they saw was `signup not available` — the server's own
// wording, written for an API client, in English, naming nothing they could act on.
import { describe, it, expect } from "vitest";
import { createWorkspaceMessage } from "./routes";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

/** A translator that answers from the real resource file, so a missing key fails here. */
const translator = (locale: { auth: Record<string, string> }) => (key: string): string => {
  const value = locale.auth[key.replace(/^auth\./, "")];
  expect(value, `${key} is not in this locale`).toBeTruthy();
  return value!;
};

describe("#806 the workspace-name step", () => {
  it("tells a 404 apart from a failed attempt", () => {
    const t = translator(en);
    expect(createWorkspaceMessage(404, { error: "signup not available" }, t)).toBe(en.auth.signupUnavailable);
    // ⚠️ The point is what it is NOT: the server's string reaching the screen is the defect.
    expect(createWorkspaceMessage(404, { error: "signup not available" }, t)).not.toContain("signup not available");
  });

  it("says the same thing in Japanese", () => {
    // Both locales carry the key, and the two are not the same string — a missing translation that
    // falls through to English would pass a test that only asserted "something came back".
    expect(createWorkspaceMessage(404, {}, translator(ja))).toBe(ja.auth.signupUnavailable);
    expect(ja.auth.signupUnavailable).not.toBe(en.auth.signupUnavailable);
  });

  it("leaves the other statuses alone, because this ticket did not create them", () => {
    const t = translator(en);
    expect(createWorkspaceMessage(409, { error: "workspace name taken" }, t)).toBe("workspace name taken");
    expect(createWorkspaceMessage(500, {}, t)).toBe(en.auth.createWorkspaceError);
  });
});
