// @vitest-environment happy-dom
// #745 (review rejection): choosing a passkey IS presenting it.
//
// The owner, at the screen, found it jarring that pressing "use a passkey" still required a second
// confirm-with-passkey button before getting in. The chooser landed in the shape of the
// recovery-code screen — pick a method,
// then act on it — and for a passkey the second step had nothing in it: no field to fill, no decision
// to make, just a button that repeated the one already pressed. The click that picks the kind is the
// user activation the ceremony needs, so the browser prompt can open on that click.
//
// A code is different, and that is the whole rule: it has to be typed, so choosing it can only reveal
// a field. The predicate therefore belongs to the KIND (settings/factor-kind.ts) and both screens ask
// it — the door and the recovery-code panel grew this shape separately once already.
//
// MEASURED BY DRIVING THE SCREEN. A source grep for the handler cannot tell a call that happens on the
// click from one that happens behind a second button, and this defect was precisely a second button.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bundles = Object.fromEntries(["en", "ja"].map((l) =>
  [l, JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${l}.json`), "utf8"))]));
const copy = (key: string): string =>
  key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundles.en) as string;

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (k: string, v?: Record<string, string>) => (copy(k) ?? k).replace(/\{\{(\w+)\}\}/g, (_m, n) => v?.[n] ?? ""),
    i18n: { language: "en" },
  }),
}));
const startAuthentication = vi.fn(async () => ({ id: "assertion" }));
vi.mock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn(), startAuthentication }));

const { FactorStep } = await import("./FactorStep");
const { proofBeginsOnChoice } = await import("../settings/factor-kind");

/** Every POST the screen makes, in order — the ceremony's first move is a call, so this is the signal. */
let posted: string[] = [];
beforeEach(() => {
  posted = [];
  // The door hides a passkey the WINDOW cannot perform (#686's predicate), and happy-dom has no
  // WebAuthn — without this the chooser under test never renders and every assertion below would be
  // measuring the lock-out message instead.
  (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};
  startAuthentication.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    posted.push(new URL(url, "http://localhost").pathname);
    // Options for the ceremony, then a receipt that never resolves into a redirect (this test is
    // about the START, and a member who signs in navigates away from the thing being measured).
    return { ok: true, json: async () => ({ options: {} }) } as unknown as Response;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Renders the door in the state that has a fork, and returns a handle on its buttons. */
function door(kinds: string[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(FactorStep as never, { stage: "required", kinds, recovery: false, returnTo: "/" })); });
  return {
    click: (testid: string) => {
      const el = host.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null;
      expect(el, `the screen has a ${testid}`).not.toBeNull();
      act(() => { el!.click(); });
    },
    has: (testid: string) => host.querySelector(`[data-testid="${testid}"]`) !== null,
    text: () => host.textContent ?? "",
    done: () => { act(() => root.unmount()); host.remove(); },
  };
}

describe("#745 picking a passkey starts the ceremony", () => {
  it("one click — the chooser's own click opens the browser prompt", async () => {
    const d = door(["totp", "passkey"]);
    try {
      d.click("login-factor-choose-passkey");
      await act(async () => { await Promise.resolve(); });
      // The defect, stated as a measurement: before the fix this list was EMPTY until a second
      // button was pressed.
      // Suffix, not the whole path: `assetUrl` puts the API prefix in front, and pinning that here
      // would make this test fail the day the prefix moves for reasons that have nothing to do with it.
      expect(posted.join(" "), `the choice asked the server for the assertion options — it called: ${posted.join(", ")}`)
        .toContain("/auth/local/factor/passkey/options");
    } finally { d.done(); }
  });

  it("a code still waits to be typed — the rule is about the kind, not about the screen", () => {
    const d = door(["totp", "passkey"]);
    try {
      d.click("login-factor-choose-totp");
      expect(posted, "choosing a code must not call anything — there is nothing to present yet").toEqual([]);
      expect(d.has("login-factor-code"), "it revealed the field instead").toBe(true);
    } finally { d.done(); }
  });

  it("the way back in after a dismissed prompt is still there, and says so", async () => {
    // Cancelling the browser's key prompt is not an error the member caused; the button that was a
    // pointless first step becomes a meaningful second one.
    startAuthentication.mockRejectedValueOnce(new Error("user cancelled"));
    const d = door(["totp", "passkey"]);
    try {
      d.click("login-factor-choose-passkey");
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(d.has("login-factor-passkey"), "no way to try again").toBe(true);
      expect(d.text()).toContain(copy("auth.factorPresentPasskeyAgain"));
    } finally { d.done(); }
  });

  it("the member with ONE proof presses once too", async () => {
    // No chooser for them (#745's own ruling), so the single button IS the first press — it must not
    // fire on its own either, because a page that opens a key prompt on arrival is its own defect.
    const d = door(["passkey"]);
    try {
      expect(posted, "arriving at the door must not start a ceremony nobody asked for").toEqual([]);
      d.click("login-factor-passkey");
      await act(async () => { await Promise.resolve(); });
      expect(posted.join(" "), `it called: ${posted.join(", ")}`).toContain("/auth/local/factor/passkey/options");
    } finally { d.done(); }
  });

  it("the rule lives with the kind, and both screens can ask it", () => {
    expect(proofBeginsOnChoice("passkey")).toBe(true);
    expect(proofBeginsOnChoice("totp")).toBe(false);
    expect(proofBeginsOnChoice("password")).toBe(false);
  });
});

// The other screen with a chooser (#650's recovery codes). It grew the same two-step shape as the
// door, independently, and the owner met it on the door first — so it is fixed here in the same turn
// rather than waiting to be reported a second time.
//
// Driven through the handler rather than the rendered panel: the decision lives in what the screen
// DOES with the pick, and the panel around it needs a query client, a member and a live challenge to
// mount at all. The handler takes its effects as arguments precisely so this can be measured.
describe("#745 the recovery-code screen picks the same way", () => {
  it("choosing a passkey presents it — no second button in between", async () => {
    const { pickReauthMethod } = await import("../settings/RecoveryCodesPanel");
    const calls: string[] = [];
    pickReauthMethod("passkey" as never, {
      setMethod: () => calls.push("set"), resetProof: () => calls.push("reset"), present: () => calls.push("present"),
    });
    expect(calls, "the ceremony started on the choice").toContain("present");
  });

  it("choosing a code does not — it has a field to fill first", async () => {
    const { pickReauthMethod } = await import("../settings/RecoveryCodesPanel");
    const calls: string[] = [];
    for (const m of ["totp", "password"]) {
      pickReauthMethod(m as never, {
        setMethod: () => calls.push(`set:${m}`), resetProof: () => calls.push(`reset:${m}`), present: () => calls.push(`present:${m}`),
      });
    }
    expect(calls.filter((c) => c.startsWith("present")), "a typed proof must not start anything").toEqual([]);
  });

  it("going back to the chooser starts nothing", async () => {
    // `onPick(null)` is the "use another method" way back. It shares this handler, and a null that
    // fell into the passkey branch would open a prompt the reader was walking away from.
    const { pickReauthMethod } = await import("../settings/RecoveryCodesPanel");
    let presented = 0;
    pickReauthMethod(null, { setMethod: () => {}, resetProof: () => {}, present: () => { presented += 1; } });
    expect(presented).toBe(0);
  });
});
