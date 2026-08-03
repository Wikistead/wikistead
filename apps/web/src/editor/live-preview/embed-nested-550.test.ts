// @vitest-environment happy-dom
// #550: an `:::embed-external` nested in a layout container (tabs / columns / details) rendered its
// "…" placeholder forever, on the read AND edit surfaces — the host's allowlist-check + swap lived
// only in the top-level MacroWidget (a by-name branch), so the nested sink never answered. Third
// occurrence of the #450 "renders top-level only" defect (after tagged/children and the
// embed-page/diagram seams); fixed the same way: the macro asks for a host slot ({kind:"embed"}), the
// host answers on every surface that installs the embed seam.
//
// The authz-shaped pin (per the ticket's red-check): the allowlist decision stays HOST-side and keeps
// biting at any depth — a non-allowlisted host degrades to a link inside a container too. A nested
// path that skipped the allowlist would be an authorization hole.
import { describe, it, expect } from "vitest";
import { renderMarkdownToDom, withEmbedHost, dispatchMacroRender, type EmbedHostSeam } from "../macros/md-render";
import { buildEmbedElement, embedMacro } from "../macros/embed";
import en from "../../i18n/locales/en.json";
import "../macros"; // register embed-external / tabs / details so the nested sink resolves them

const ALLOW = ["youtube.com"];
const seam: EmbedHostSeam = { build: (url) => buildEmbedElement(url, ALLOW) };
const ALLOWED = "https://www.youtube.com/embed/abc";
const BLOCKED = "https://evil.example/thing";

const renderNested = (doc: string) => {
  let dom: HTMLElement = document.createElement("div");
  withEmbedHost(seam, () => {
    dom.appendChild(renderMarkdownToDom(doc));
  });
  return dom;
};

describe("#550 nested embed-external resolves through the host slot", () => {
  it("inside :::tabs — the allowlisted URL becomes a sandboxed iframe, never the placeholder", () => {
    const dom = renderNested(`::::tabs\n:::tab{title="A"}\n:::embed-external\n${ALLOWED}\n:::\n:::\n::::`);
    const frame = dom.querySelector("[data-testid=macro-embed-frame]") as HTMLIFrameElement;
    expect(frame, "the iframe rendered at depth").toBeTruthy();
    expect(frame.src).toBe(ALLOWED);
    expect(frame.getAttribute("sandbox"), "still sandboxed at depth").toContain("allow-scripts");
    // the ticket's measurement: no leaf sits at the raw placeholder
    // #600 re-aim: the placeholder used to be the literal "…" and is now a named sentence. What this
    // pin is about is unchanged — nothing unresolved may survive next to a working iframe.
    const stalled = Array.from(dom.querySelectorAll("*")).filter(
      (el) => el.children.length === 0 && (el.textContent ?? "").includes(en.macro.name.embed),
    );
    expect(stalled, "no unresolved placeholder survives").toHaveLength(0);
  });

  it("inside :::details (folded container) — same lifecycle", () => {
    const dom = renderNested(`::::details{summary="More"}\n:::embed-external\n${ALLOWED}\n:::\n::::`);
    expect(dom.querySelector("[data-testid=macro-embed-frame]")).toBeTruthy();
  });

  it("AUTHZ: a non-allowlisted host degrades to a safe link at depth — nesting never skips the allowlist", () => {
    const dom = renderNested(`::::tabs\n:::tab{title="A"}\n:::embed-external\n${BLOCKED}\n:::\n:::\n::::`);
    expect(dom.querySelector("[data-testid=macro-embed-frame]"), "no iframe for an unlisted host").toBeNull();
    const degrade = dom.querySelector("[data-testid=macro-embed-degrade]") as HTMLAnchorElement;
    expect(degrade, "degrades to the link, not a broken frame").toBeTruthy();
    expect(degrade.tagName).toBe("A");
    expect(degrade.href).toContain("evil.example");
  });

  it("no seam installed (export / hover surfaces): the macro keeps its own placeholder — never an unchecked iframe", () => {
    const dom = document.createElement("div");
    dom.appendChild(renderMarkdownToDom(`::::tabs\n:::tab{title="A"}\n:::embed-external\n${ALLOWED}\n:::\n:::\n::::`));
    expect(dom.querySelector("[data-testid=macro-embed-frame]"), "nobody vouched for the URL → no frame").toBeNull();
    // #600: it names itself now — a reader who meets this block on an export knows what it is.
    const ph = dom.querySelector("[data-testid=macro-embed-external]")?.textContent ?? "";
    expect(ph, "the placeholder says which macro it is").toContain(en.macro.name.embed);
    expect(ph, "…and no longer says nothing at all").not.toBe("…");
  });

  it("top level goes through the SAME slot (one lifecycle, not two kept in step)", () => {
    const el = dispatchMacroRender(embedMacro as never, ALLOWED, {
      theme: {} as never,
      slotEnv: { embed: seam },
    })!;
    expect(el.querySelector("[data-testid=macro-embed-frame]"), "the dispatch answered the macro's ask").toBeTruthy();
    // and with no seam, the same dispatch yields the placeholder (surface decides, macro is constant)
    const bare = dispatchMacroRender(embedMacro as never, ALLOWED, { theme: {} as never })!;
    expect(bare.textContent, "the placeholder, naming itself").toContain(en.macro.name.embed);
  });
});

describe("#550 nested embed-page still resolves (the sibling seam — pinned so it cannot regress silently)", () => {
  it("inside :::tabs the transclude seam answers (existing #450 slice-3 path)", async () => {
    const { withTranscludeHost } = await import("../macros/md-render");
    const dom = document.createElement("div");
    withTranscludeHost({ resolve: async () => "resolved **body**", deniedLabel: "Cannot display this content" }, () => {
      dom.appendChild(renderMarkdownToDom(`::::tabs\n:::tab{title="A"}\n:::embed-page\npage-ref\n:::\n:::\n::::`));
    });
    await Promise.resolve(); await Promise.resolve();
    const holder = dom.querySelector("[data-testid=macro-embed-page-nested]") as HTMLElement;
    expect(holder, "the nested embed-page holder mounted").toBeTruthy();
    expect(holder.textContent).toContain("resolved");
  });
});
