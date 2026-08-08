// #683: a confirmation's heading says the same thing its body asks.
//
// Turning two-factor OFF opened a dialog headed "Require two-factor authentication" above a body ending
// "Stop requiring two-factor authentication?" — the heading said the opposite of the question. #674 put
// that confirmation there *because* switching off lowers the tenant's security, and the first line read
// undid the reason for asking.
//
// The ticket asked for this to be measured by WALKING rather than by listing the four dialogs: "3
// ". So the table the component uses is walked here, and every entry in it has
// to hold the property. A stance added tomorrow is covered by the walk; a stance added tomorrow and
// forgotten here is not something this file can be wrong about, because the walk reads the table itself.
import { describe, it, expect, beforeAll } from "vitest";
import i18next, { type i18n as I18n } from "i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import { STANCE_COPY } from "../settings/AdminSignInMethodsSection";

let i18n: I18n;

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    resources: { en: { translation: en }, ja: { translation: ja } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
});

const STANCES = Object.keys(STANCE_COPY) as (keyof typeof STANCE_COPY)[];

describe("#683: the heading follows the direction, in every confirmation", () => {
  it("the table covers the switches this screen has", () => {
    // The premise. A walk over an empty or halved table proves nothing, and the failure being guarded
    // against — somebody adding a stance and giving it only a body — shows up here first.
    expect(STANCES.length, "there are fewer stance confirmations than switches").toBeGreaterThanOrEqual(2);
    for (const s of STANCES) {
      expect(Object.keys(STANCE_COPY[s]).sort(), `${s} does not have both directions`).toEqual(["off", "on"]);
      for (const way of ["on", "off"] as const) {
        expect(STANCE_COPY[s][way].title, `${s}/${way} has no heading`).toMatch(/\S/);
        expect(STANCE_COPY[s][way].message, `${s}/${way} has no body`).toMatch(/\S/);
      }
    }
  });

  for (const lng of ["en", "ja"] as const) {
    it(`${lng}: turning something off is not headed as turning it on`, async () => {
      await i18n.changeLanguage(lng);
      for (const s of STANCES) {
        const on = STANCE_COPY[s].on;
        const off = STANCE_COPY[s].off;
        const [onTitle, offTitle] = [i18n.t(on.title), i18n.t(off.title)];
        const [onBody, offBody] = [i18n.t(on.message), i18n.t(off.message)];

        // The defect, exactly: one heading served both directions.
        expect(offTitle, `${s}: switching off is headed the same as switching on (${onTitle})`)
          .not.toBe(onTitle);
        // …and the bodies really were two questions, so the line above is about the heading rather than
        // about a dialog that says one thing throughout.
        expect(offBody, `${s}: the two directions ask the same question`).not.toBe(onBody);

        // Every one of them resolved. A missing key renders as the key itself, which would pass "not
        // equal" while putting `adminAuth.…` on screen.
        for (const said of [onTitle, offTitle, onBody, offBody]) {
          expect(said, "a key resolved to itself").not.toMatch(/^adminAuth\./);
        }
      }
    });
  }

  it("the two halves of a dialog come from one entry, so they cannot be edited apart", () => {
    // The structural half of the ruling. What broke was two ternaries reading the same flag with one of
    // them written without it — an arrangement where nothing says the answers must agree. Here the
    // heading and the body are fields of ONE object per direction, so a heading has nowhere to live
    // except beside the question it belongs to.
    for (const s of STANCES) {
      for (const way of ["on", "off"] as const) {
        const entry = STANCE_COPY[s][way];
        expect(Object.keys(entry).sort(), `${s}/${way} is not a heading-and-body pair`)
          .toEqual(["message", "title"]);
        // …and the pair belongs to the same direction: both key names carry it.
        const marker = way === "on" ? "Enable" : "Disable";
        expect(entry.title, `${s}/${way}'s heading is not the ${way} one`).toContain(marker);
        expect(entry.message, `${s}/${way}'s body is not the ${way} one`).toContain(marker);
      }
    }
  });
});
