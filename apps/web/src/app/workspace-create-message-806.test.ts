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

  // #871: the other four statuses were still the server's English. `POST /signup/tenants` answers
  // 404 / 409 / 400 / 401 / 500, and the one a person meets most is 409 — names are taken by other
  // people, so the commonest outcome of the commonest mistake was the least readable.
  it("answers every status this route can give, in the reader's language", () => {
    const t = translator(en);
    expect(createWorkspaceMessage(409, { error: "workspace name taken" }, t)).toBe(en.auth.workspaceNameTaken);
    expect(createWorkspaceMessage(400, { error: "invalid workspace name" }, t)).toBe(en.auth.workspaceNameInvalid);
    expect(createWorkspaceMessage(401, { error: "no signup session" }, t)).toBe(en.auth.signupSessionExpired);
    expect(createWorkspaceMessage(500, { error: "could not create workspace" }, t)).toBe(en.auth.createWorkspaceError);
  });

  // ⚠️ The claim is not "each status has a sentence" — it is that the SERVER'S sentence never
  // arrives. A mapping that forgot one status would still pass the test above by falling through to
  // `body.error`; this one names the strings the route actually sends and refuses all of them,
  // including on a status nobody listed.
  it("never renders the server's own string, on any status", () => {
    const t = translator(en);
    const sent = ["signup not available", "no signup session", "invalid workspace name", "workspace name taken", "could not create workspace"];
    for (const status of [400, 401, 404, 409, 418, 500, 503]) {
      for (const error of sent) {
        expect(createWorkspaceMessage(status, { error }, t), `${status} rendered the server's words`).not.toContain(error);
      }
    }
  });

  it("says all of it in Japanese too, and not by copying English", () => {
    const t = translator(ja);
    expect(createWorkspaceMessage(409, { error: "workspace name taken" }, t)).toBe(ja.auth.workspaceNameTaken);
    expect(createWorkspaceMessage(400, {}, t)).toBe(ja.auth.workspaceNameInvalid);
    expect(createWorkspaceMessage(401, {}, t)).toBe(ja.auth.signupSessionExpired);
    // A locale file that carried the key with the English text would satisfy every assertion above.
    expect(ja.auth.workspaceNameTaken).not.toBe(en.auth.workspaceNameTaken);
    expect(ja.auth.workspaceNameInvalid).not.toBe(en.auth.workspaceNameInvalid);
    expect(ja.auth.signupSessionExpired).not.toBe(en.auth.signupSessionExpired);
  });
});
