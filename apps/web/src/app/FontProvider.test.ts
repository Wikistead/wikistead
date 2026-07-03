// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { applyFontBody } from "./FontProvider";

// #190 / ADR-090: the device-local body-font override. A forced choice writes an inline --font-body on
// <html> (beating the locale default); "locale" clears it so the locale default applies again. Verify
// the REAL DOM effect with distinct values per choice (not just "it ran").
describe("applyFontBody (#190 body-font override)", () => {
  beforeEach(() => { document.documentElement.style.removeProperty("--font-body"); });

  it("'mono' writes the Wikistead Mono stack; 'udev' writes UDEV — distinct, non-empty", () => {
    applyFontBody("mono");
    const mono = document.documentElement.style.getPropertyValue("--font-body");
    expect(mono).toContain("Wikistead Mono");
    applyFontBody("udev");
    const udev = document.documentElement.style.getPropertyValue("--font-body");
    expect(udev).toContain("UDEV Gothic");
    expect(udev).not.toBe(mono); // the choice actually changes the face (not a no-op)
  });

  it("'sans' writes a PROPORTIONAL stack (Inter) — distinct from the monospace choices (#190 comment 614)", () => {
    applyFontBody("sans");
    const sans = document.documentElement.style.getPropertyValue("--font-body");
    expect(sans).toContain("Inter");
    expect(sans).toContain("sans-serif"); // proportional, not monospace
    applyFontBody("mono");
    expect(document.documentElement.style.getPropertyValue("--font-body")).not.toBe(sans);
  });

  it("'locale' REMOVES the inline override (falls back to the locale default)", () => {
    applyFontBody("mono");
    expect(document.documentElement.style.getPropertyValue("--font-body")).not.toBe("");
    applyFontBody("locale");
    expect(document.documentElement.style.getPropertyValue("--font-body")).toBe("");
  });
});
