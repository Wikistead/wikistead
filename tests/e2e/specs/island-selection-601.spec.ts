import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #601: selecting text inside a macro's editor made the text disappear on dark. Every nested editor
// (the slot islands, the callout panel, the details panel, the mermaid and plantuml source panes)
// declined the app's CodeMirror theme — reasonably, since it also paints a background they must not
// have — and so inherited CodeMirror's own selection colour, #d7d4f0. That colour is the LIGHT default
// and it was used on dark too: measured at 1.06:1 against the text.
//
// Real browser, because none of this is decidable from source: the colour comes from a stylesheet
// CodeMirror injects at runtime, `--selection` is semi-transparent so what a reader actually sees is a
// composite with whatever is behind it, and "behind it" is panel chrome that varies per surface.
//
// All five surfaces, not the one that was reported. They share a single mount function, so a fix that
// only reached one of them would mean the fix was in the wrong place.

const CM_LIGHT_DEFAULT = "rgb(215, 212, 240)"; // #d7d4f0, from @codemirror/view's baseTheme

// The measurement, in the page: what a reader sees where the selection meets the text. Backgrounds are
// composited up the ancestor chain because `--selection` is a wash, not a colour — asserting on the
// declared string would keep passing if the token turned into something invisible.
const MEASURE = (testid: string) => {
  const surface = document.querySelector(`[data-testid="${testid}"]`);
  if (!surface) return { error: `no surface ${testid}` };
  const view = surface.closest(".cm-editor");
  if (!view) return { error: `${testid} is not inside a .cm-editor` };
  const sel = view.querySelector(".cm-selectionBackground");
  if (!sel) return { error: `${testid} drew no selection` };

  const parse = (c: string): [number, number, number, number] => {
    const n = c.match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) ?? [];
    // A `color-mix()` value comes back from Chromium as `color(srgb r g b / a)` with 0..1 components,
    // NOT as rgba() with 0..255. Reading it as rgba turns a pale wash into near-black and the measured
    // contrast becomes fiction — which is exactly how this helper first "found" a defect that was its
    // own arithmetic.
    if (c.startsWith("color(")) return [(n[0] ?? 0) * 255, (n[1] ?? 0) * 255, (n[2] ?? 0) * 255, n[3] ?? 1];
    return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? (c === "transparent" ? 0 : 1)];
  };
  // From the selection layer up: stack the backgrounds until one is opaque, then composite downward.
  const stack: Array<[number, number, number, number]> = [];
  for (let el: Element | null = sel; el; el = el.parentElement) {
    const c = parse(getComputedStyle(el).backgroundColor);
    if (c[3] > 0) stack.push(c);
    if (c[3] === 1) break;
  }
  stack.push([255, 255, 255, 1]); // the page beneath everything, if nothing opaque was found
  let [r, g, b] = stack[stack.length - 1] as [number, number, number, number];
  for (let i = stack.length - 2; i >= 0; i--) {
    const [sr, sg, sb, sa] = stack[i]!;
    r = sr * sa + r * (1 - sa);
    g = sg * sa + g * (1 - sa);
    b = sb * sa + b * (1 - sa);
  }
  const fg = parse(getComputedStyle(view.querySelector(".cm-content") ?? view).color);
  const lum = (c: number[]) => {
    const f = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * f[0]! + 0.7152 * f[1]! + 0.0722 * f[2]!;
  };
  const a = lum([r, g, b]);
  const c2 = lum(fg);
  return {
    // the chain, so a failure says WHERE the colour came from rather than only that it was wrong
    chain: stack.map((c, i) => `${i}:rgba(${c.slice(0, 3).map(Math.round).join(",")},${c[3]!.toFixed(2)})`).join(" < "),
    declared: getComputedStyle(sel).backgroundColor,
    composited: `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`,
    fg: `rgb(${fg[0]}, ${fg[1]}, ${fg[2]})`,
    contrast: (Math.max(a, c2) + 0.05) / (Math.min(a, c2) + 0.05),
  };
};

async function selectAllIn(page: Page, testid: string) {
  await page.getByTestId(testid).click();
  await sleep(150);
  await page.keyboard.press("Control+a");
  await sleep(200);
}

// Each surface, and how a person reaches it.
const SURFACES: Array<{ name: string; testid: string; doc: string; open: (p: Page) => Promise<void> }> = [
  {
    name: "a layout slot island (the reported case)",
    testid: "slot-edit-src",
    doc: "top\n\n::::columns\n:::column\nAAA content here\n:::\n:::column\nBBB\n:::\n::::\n\nbelow\n",
    open: async (p) => { await p.locator("[data-pane=preview] .cm-lp-column").first().click(); await sleep(300); },
  },
  {
    name: "the callout edit panel",
    testid: "callout-edit-body",
    doc: ":::warning\nwatch out here\n:::\n\nbelow\n",
    open: async (p) => {
      await p.locator("[data-pane=preview] .cm-lp-callout-panel").first().hover();
      await p.getByTestId("callout-panel-edit").click();
      await sleep(400);
    },
  },
  {
    name: "the details edit panel",
    testid: "details-edit-body",
    doc: ":::details[More]\noriginal body text\n:::\n\nbelow\n",
    open: async (p) => {
      await p.keyboard.press("ArrowUp");
      await p.keyboard.press("ArrowUp");
      await sleep(200);
      await p.keyboard.press("Control+Enter");
      await sleep(600);
    },
  },
  {
    name: "the mermaid source pane",
    testid: "mermaid-edit-src",
    doc: "```mermaid\ngraph TD;A-->B;\n```\n\nbelow\n",
    open: async (p) => {
      const wrap = p.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
      await wrap.hover();
      await sleep(200);
      await wrap.locator(".cm-lp-macro-edit").first().click({ force: true });
      await sleep(500);
    },
  },
  {
    name: "the plantuml source pane",
    testid: "plantuml-edit-src",
    doc: "```plantuml\n@startuml\na -> b\n@enduml\n```\n\nbelow\n",
    open: async (p) => {
      const wrap = p.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
      await wrap.hover();
      await sleep(200);
      await wrap.locator(".cm-lp-macro-edit").first().click({ force: true });
      await sleep(500);
    },
  },
];

async function setTheme(page: Page, name: "Dark" | "Light") {
  await page.click("[data-testid=theme-toggle]");
  await page.locator("[data-testid=theme-menu]").getByText(name, { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", name.toLowerCase());
  await sleep(200);
}

for (const surface of SURFACES) {
  for (const theme of ["Dark", "Light"] as const) {
    test(`#601: ${surface.name} selects readably on ${theme.toLowerCase()}`, async ({ browser }) => {
      const page = await (await browser.newContext()).newPage();
      await openScratch(page, `sel601-${surface.testid}-${theme}-${Date.now()}`);
      await setTheme(page, theme);
      await enterEdit(page);
      await page.click("[data-pane=preview] .cm-content");
      await page.keyboard.insertText(surface.doc);
      await sleep(700);
      await page.getByText("below", { exact: true }).click();
      await sleep(400);

      await surface.open(page);
      await expect(page.getByTestId(surface.testid)).toBeVisible({ timeout: 8000 });
      await selectAllIn(page, surface.testid);

      const m = await page.evaluate(MEASURE, surface.testid);
      expect(m.error ?? "", `measuring ${surface.testid}`).toBe("");
      // The specific wrong colour, named: it is CodeMirror's light default, and it was showing on both
      // themes because nothing told the nested view which theme it was in.
      expect(m.declared, "the editor's own light default is not what a nested editor uses").not.toBe(CM_LIGHT_DEFAULT);
      // …and the property that actually matters, which the colour string alone cannot promise.
      expect(
        m.contrast,
        `selected text must stay readable (bg ${m.composited} vs text ${m.fg}; chain ${m.chain})`,
      ).toBeGreaterThan(4.5);
    });
  }
}

// The other half of the fix, pinned on its own: CodeMirror decides light-vs-dark from a FACET, and picks
// a generated base class from it (`baseDarkID` / `baseLightID` in its source). The nested editors used to
// carry a hand-set `cm-dark` class instead, which CodeMirror never reads and no app stylesheet matches —
// so as far as the library was concerned every island was a light editor. Colouring the selection alone
// would hide that while leaving the caret, the panels and the unfocused selection on the wrong branch.
test("#601: a nested editor is told which theme it is in, not just handed a class nobody reads", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `sel601-facet-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\nAAA content here\n:::\n:::column\nBBB\n:::\n::::\n\nbelow\n");
  await sleep(700);
  await page.getByText("below", { exact: true }).click();
  await sleep(400);

  const islandClasses = async () => {
    await page.locator("[data-pane=preview] .cm-lp-column").first().click();
    await sleep(400);
    // `cm-dark` is EXCLUDED on purpose: it is the class the editor set by hand, the one nothing reads.
    // Leaving it in made this comparison pass with the facet removed — it was measuring the very thing
    // the ticket says does nothing. What must differ is the class CodeMirror itself picks.
    const cls = await page.getByTestId("slot-edit-src").evaluate((el) =>
      el.closest(".cm-editor")!.className.split(/\s+/).filter((c) => c && c !== "cm-dark").sort().join(" "));
    await page.getByText("below", { exact: true }).click(); // blur → the island commits and closes
    await sleep(300);
    return cls;
  };

  await setTheme(page, "Dark");
  const dark = await islandClasses();
  await setTheme(page, "Light");
  const light = await islandClasses();

  expect(dark, "the island mounted").toContain("cm-editor");
  expect(dark, "CodeMirror picks a different base theme per mode — the island must get the right one").not.toBe(light);
});
