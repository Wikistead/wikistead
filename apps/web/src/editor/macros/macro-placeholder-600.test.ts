// @vitest-environment happy-dom
// #600: a block that cannot show its content must still say WHAT IT IS. Four states used to say
// nothing — `…`, an empty node, or a hardcoded English sentence — so a reader met a block with no way
// to tell whether it was an embed, a diagram or a page reference.
//
// The pin is DISCOVERY-shaped (the #544 lesson: an enumerated list waves the next one through). It
// walks the registry, renders every macro with an EMPTY body, and requires that whatever comes back is
// either real structure or a sentence that names the macro. A macro added tomorrow is checked by
// existing, without anyone editing this file.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { registeredMacros } from "./index";
import { dispatchMacroRender } from "./md-render";
import { macroPlaceholder, macroDisplayName, deniedEmbedLabel, type MacroPlaceholderState } from "./placeholder";
import en from "../../i18n/locales/en.json";
import ja from "../../i18n/locales/ja.json";

const here = import.meta.dirname;
const ctx = { theme: "light" } as never;

describe("#600: every macro names itself when it cannot show its content", () => {
  it("the discovery actually found the macros (a pin over an empty set proves nothing)", () => {
    expect(registeredMacros().length).toBeGreaterThan(10);
  });

  it("an empty body never renders as a blank box or a bare ellipsis", () => {
    for (const macro of registeredMacros()) {
      const el = dispatchMacroRender(macro as never, "", { theme: ctx });
      if (!el) continue; // container directives (callout, columns) have no liveRender — the body IS the content
      const text = (el.textContent ?? "").trim();
      const id = macro.kind === "fence" ? macro.lang : macro.name;
      // The body is EMPTY, so there is no content this could legitimately be showing: whatever comes
      // back is a placeholder, and a placeholder has to say what it stands for.
      expect(text, `${id} renders an empty box for an empty body`).not.toBe("");
      expect(text, `${id} renders "…", which tells a reader nothing`).not.toBe("…");
      expect(text, `${id}'s placeholder does not name it`).toContain(macroDisplayName(macro));
    }
  });

  it("every macro's name is a localised one, not its raw id", () => {
    // #600 bounce (measured on the device): a Japanese UI said "table". `table` has no slash entry
    // a table is inserted from the toolbar — so `macroDisplayName` fell through to the directive id and
    // the sentence this ticket unified was English in one slot out of five. The palette already had the
    // word; nothing new had to be written. Pinned as "every macro resolves through a key that exists in
    // BOTH locales", so the next macro without a name fails here rather than on someone's screen.
    const flat = (o: Record<string, unknown>, p = ""): Set<string> => {
      const out = new Set<string>();
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === "object") for (const x of flat(v as Record<string, unknown>, `${p}${k}.`)) out.add(x);
        else out.add(`${p}${k}`);
      }
      return out;
    };
    const inEn = flat(en as unknown as Record<string, unknown>);
    const inJa = flat(ja as unknown as Record<string, unknown>);
    const nameless: string[] = [];
    for (const macro of registeredMacros()) {
      const id = macro.kind === "fence" ? macro.lang : macro.name;
      const key = (macro as { nameKey?: string }).nameKey ?? macro.slash?.labelKey;
      if (!key) nameless.push(`${id}: no nameKey and no palette label — its placeholder would show "${id}"`);
      else if (!inEn.has(key) || !inJa.has(key)) nameless.push(`${id}: ${key} is missing from ${inEn.has(key) ? "ja" : "en"}`);
    }
    expect(nameless).toEqual([]);
  });

  it("no macro builds its own placeholder sentence — they all go through the one template", () => {
    // The defect being pinned is FOUR shapes in one slot ("Empty drawing: …", "Invalid PlantUML
    // diagram", "Could not reach the diagram renderer", "Cannot display this content"), which happened
    // because each macro wrote its own. A fifth shape would have to bypass the template to exist.
    const offenders: string[] = [];
    for (const file of readdirSync(here).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
      if (file === "placeholder.ts") continue;
      const src = readFileSync(resolve(here, file), "utf8");
      // a placeholder key read directly, rather than through macroPlaceholder
      if (/i18n\.t\(\s*["'`]macro\.(placeholder|state|next)/.test(src)) offenders.push(`${file}: reads a placeholder key directly`);
      // an English sentence assigned straight to textContent (the hardcoded-copy shape)
      for (const m of src.matchAll(/textContent\s*=\s*"([^"]{12,})"/g)) {
        offenders.push(`${file}: hardcoded placeholder copy ${JSON.stringify(m[1])}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no code asks for a macro.* copy key that does not exist", () => {
    // How this pin came to exist: retiring the old keys left ONE caller behind (the editor's generic
    // empty-macro placeholder, in a file typecheck cannot help with because a copy key is a string).
    // It would have shipped as the literal text "macro.emptyEdit" on screen. Whole-tree, so the next
    // rename is caught wherever its callers live.
    const web = resolve(here, "../../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === "locales") continue;
        const p = resolve(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) files.push(p);
      }
    };
    walk(resolve(web, "src"));
    expect(files.length, "the walk found the app").toBeGreaterThan(50);
    const flat = new Set<string>();
    const add = (obj: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === "object") add(v as Record<string, unknown>, `${prefix}${k}.`);
        else flat.add(`${prefix}${k}`);
      }
    };
    add(en.macro as unknown as Record<string, unknown>, "macro.");
    const missing: string[] = [];
    for (const f of files) {
      // Every quoted `macro.*` in CODE, not just the ones passed straight to t: the caller that got
      // left behind chose its key with a ternary, which a `t("…")` pattern walks right past. Comments
      // are stripped so a note ABOUT a retired key is not mistaken for a call.
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
      for (const m of code.matchAll(/["'`](macro\.[A-Za-z0-9_.]+)["'`]/g)) {
        if (!flat.has(m[1]!)) missing.push(`${f.slice(web.length + 1)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("both locales carry every state, and the template puts the name and the detail together", () => {
    const states: MacroPlaceholderState[] = [
      "empty-edit", "empty-open", "empty-url", "empty-page",
      "loading", "no-host", "hidden", "invalid", "unreachable",
    ];
    for (const loc of [en, ja] as unknown as Array<{ macro: Record<string, string | Record<string, string>> }>) {
      for (const k of ["placeholder", "placeholderEmpty", "nextEdit", "nextOpen", "nextAddUrl", "nextAddPage",
        "stateLoading", "stateNoHost", "stateHidden", "stateInvalid", "stateUnreachable"]) {
        expect(loc.macro[k], k).toBeTruthy();
      }
      for (const tmpl of ["placeholder", "placeholderEmpty"]) {
        expect(loc.macro[tmpl] as string, `${tmpl} interpolates the macro's name`).toContain("{{name}}");
        expect(loc.macro[tmpl] as string, `${tmpl} interpolates the state`).toContain("{{detail}}");
      }
    }
    // and every state actually resolves — an unfilled key would surface as the key itself
    for (const s of states) {
      const out = macroPlaceholder("mermaid", s);
      expect(out, `${s} left an untranslated key on screen`).not.toContain("macro.");
      expect(out, `${s} did not name the macro`).toContain(en.palette.mermaid);
    }
  });

  it("the unshowable page embed still says only WHAT it is, never WHY (ADR-071)", () => {
    // Existence hiding: denied, cyclic and absent all reach `hidden` and all read identically. The
    // macro's NAME is safe (the reader typed `:::embed-page`); a reason would be an oracle.
    // Aimed at the string the PRODUCT builds (both render paths call this), not at a reconstruction of
    // it — a reason appended at the call site would slip past a pin that rebuilt the sentence itself.
    const hidden = deniedEmbedLabel();
    expect(hidden).toContain(en.macro.name.pageEmbed);
    for (const leak of ["denied", "permission", "not found", "missing", "cycle", "exist", "private"]) {
      expect(hidden.toLowerCase(), `"${leak}" would say WHY the content is not shown`).not.toContain(leak);
    }
    // one string for the whole class — the two render paths must not drift apart
    expect(deniedEmbedLabel()).toBe(hidden);
    expect(hidden, "the sentence is the template's, not a call site's").toBe(macroPlaceholder("embed-page", "hidden"));
  });

  it("a macro that renders normally gets no placeholder added to it", () => {
    // The reason a tooltip was refused: a working diagram or table is self-evident, and decorating it
    // would be noise on every page.
    const el = dispatchMacroRender(
      registeredMacros().find((m) => m.kind === "fence" && m.lang === "mermaid") as never,
      "graph TD;A-->B;",
      { theme: ctx },
    )!;
    const text = (el.textContent ?? "").trim();
    expect(text, "a diagram with a body says nothing about itself in words").toBe("");
  });
});
