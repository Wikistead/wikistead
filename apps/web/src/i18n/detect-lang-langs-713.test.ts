import { describe, it, expect, afterEach } from "vitest";
import { detectLang, LANGS } from "./index";

// #713-S1: detectLang() used to compare against 'en'/'ja' literally, so a language added to LANGS
// (S2) would be silently ignored here — a stored or browser-reported registered language falling
// back to English rather than being detected. This pins the LANGS-driven replacement directly,
// without waiting for a third language to actually exist: LANGS is monkey-patched here to include one
// (LANGS is `as const`, but nothing prevents mutating the underlying array at runtime for a test).

const KEY = "wks.lang";

function withGlobals(localStorageValue: string | null | undefined, navigatorLanguage: string, fn: () => void) {
  const store = new Map<string, string>();
  if (localStorageValue != null) store.set(KEY, localStorageValue);
  const fakeStorage: Pick<Storage, "getItem" | "setItem"> = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, v); },
  };
  const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const prevNavigator = (globalThis as { navigator?: unknown }).navigator;
  Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { language: navigatorLanguage }, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(globalThis, "localStorage", { value: prevStorage, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: prevNavigator, configurable: true });
  }
}

describe("#713-S1 detectLang reads LANGS, not a hardcoded 'ja'", () => {
  afterEach(() => {
    // restore LANGS to its shipped contents in case a test mutated it
    (LANGS as unknown as string[]).length = 0;
    (LANGS as unknown as string[]).push("en", "ja");
  });

  it("a stored, registered language wins outright", () => {
    withGlobals("ja", "en-US", () => {
      expect(detectLang()).toBe("ja");
    });
  });

  it("an unknown stored value falls through to the browser language", () => {
    withGlobals("fr", "ja-JP", () => {
      expect(detectLang()).toBe("ja");
    });
  });

  it("no stored value and an unrecognized browser language default to English", () => {
    withGlobals(null, "de-DE", () => {
      expect(detectLang()).toBe("en");
    });
  });

  // ⚠️ break-check target: a `=== 'ja'` (or 'en') literal comparison passes every case above (ja/en
  // are still in LANGS) but fails this one, once a third language is registered.
  it("a THIRD registered language (not 'en'/'ja') is detected from storage and from the browser", () => {
    (LANGS as unknown as string[]).push("de");
    withGlobals("de", "en-US", () => {
      expect(detectLang()).toBe("de");
    });
    withGlobals(null, "de-AT", () => {
      // primary-subtag match: browser reports a region LANGS doesn't carry for 'de'
      expect(detectLang()).toBe("de");
    });
  });

  it("an exact region-qualified LANGS entry is preferred over a bare-subtag guess", () => {
    (LANGS as unknown as string[]).push("pt-BR");
    withGlobals(null, "pt-BR", () => {
      expect(detectLang()).toBe("pt-BR");
    });
  });
});
