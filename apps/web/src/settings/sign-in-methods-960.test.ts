// #858 / #960, ADR-259 §3.5: review found that deleting a connection which would strand
// specific members shared #822's `confirm_required` code — so the console could only ever open #822's
// "close the last way in" dialog, which named the wrong door and never named who would actually be
// locked out. The fix is a DISTINCT code (`members_stranded`) and a distinct dialog; `confirmationNeededFor`
// is the pure seam that routes one or the other, tested here against the EXACT shapes each server route
// sends today (login-methods.ts:442-445 for #822, admin-connections.ts's DELETE handler for #960).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { confirmationNeededFor, CONFIRM_COPY } from "./AdminSignInMethodsSection";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

const read = (f: string) => readFileSync(resolve(import.meta.dirname, f), "utf8");

describe("#960: confirmationNeededFor distinguishes #822 from #960", () => {
  it("#822's exact shape (login-methods.ts assertClosingIsSafe) opens lastWayIn, naming the door", () => {
    expect(confirmationNeededFor({ code: "confirm_required", remainingKind: "oidc" }))
      .toEqual({ kind: "lastWayIn", door: "oidc" });
  });

  it("#960's exact shape (admin-connections.ts DELETE) opens membersStranded, naming the subs", () => {
    expect(confirmationNeededFor({ code: "members_stranded", strandedSubs: ["sub-a", "sub-b"] }))
      .toEqual({ kind: "membersStranded", subs: ["sub-a", "sub-b"] });
  });

  // The break-check the reviewer asked for: a response is routed by its CODE alone, never by which
  // fields happen to be present — so #822's response can never be mistaken for #960's, or vice versa,
  // regardless of what else rides along.
  it("routes by code alone — a stray strandedSubs on a #822 response does not open the #960 dialog", () => {
    const shaped822WithExtraField = { code: "confirm_required", remainingKind: "platform", strandedSubs: ["sub-a"] };
    expect(confirmationNeededFor(shaped822WithExtraField)).toEqual({ kind: "lastWayIn", door: "platform" });
  });

  it("routes by code alone — a stray remainingKind on a #960 response does not open the #822 dialog", () => {
    const shaped960WithExtraField = { code: "members_stranded", remainingKind: "oidc", strandedSubs: ["sub-a"] };
    expect(confirmationNeededFor(shaped960WithExtraField)).toEqual({ kind: "membersStranded", subs: ["sub-a"] });
  });

  it("an unrelated or absent code opens neither", () => {
    expect(confirmationNeededFor({ code: "login_lockout" })).toBeNull();
    expect(confirmationNeededFor({})).toBeNull();
    expect(confirmationNeededFor(null)).toBeNull();
  });

  it("a missing remainingKind/strandedSubs falls back to empty, never undefined (the door/name renderer needs a value)", () => {
    expect(confirmationNeededFor({ code: "confirm_required" })).toEqual({ kind: "lastWayIn", door: "" });
    expect(confirmationNeededFor({ code: "members_stranded" })).toEqual({ kind: "membersStranded", subs: [] });
  });
});

describe("#960: the members-stranded dialog is wired and named, like #822's before it", () => {
  const src = read("./AdminSignInMethodsSection.tsx");

  it("askedFirst decides through confirmationNeededFor, not a second ad-hoc code check", () => {
    expect(src).toContain("const needed = confirmationNeededFor(e);");
    expect(src).toContain('needed?.kind === "membersStranded"');
  });

  it("the dialog turns subs into display names — never a raw sub (existing #578/#859 rule)", () => {
    const dialogBlock = src.slice(src.indexOf("open={membersStranded"), src.indexOf("open={membersStranded") + 400);
    expect(dialogBlock).toContain("membersStranded.subs.map(nameOf)");
  });

  it("CONFIRM_COPY registers the new dialog (the #683 discovery pin depends on this)", () => {
    expect(CONFIRM_COPY.membersStranded).toEqual({
      title: "adminConnections.confirmStrandedTitle",
      message: "adminConnections.confirmStrandedBody",
    });
  });

  it("both locales carry the new copy, with the {{names}} interpolation", () => {
    for (const [lng, loc] of [["en", en], ["ja", ja]] as const) {
      expect(loc.adminConnections?.confirmStrandedTitle, `${lng}: title`).toBeTruthy();
      const body = loc.adminConnections?.confirmStrandedBody;
      expect(body, `${lng}: body`).toBeTruthy();
      expect(body, `${lng}: must interpolate the stranded members' names`).toContain("{{names}}");
    }
  });

  it("the server's code is quoted verbatim in the client — a renamed code on either side must fail loudly", () => {
    expect(src).toContain('"members_stranded"');
  });
});
