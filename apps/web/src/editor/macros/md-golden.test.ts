// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderMarkdownToDom } from "./md-render";
import { renderMarkdownToHtml, builtinMacroRegistry } from "@wikistead/macro-render";

// #85 (2026-08-02): the snapshots MOVED once, deliberately. A newline inside a paragraph or a quote now
// renders as a line break instead of folding into a space — the editing surface always showed those lines
// and the static surfaces did not, which reached a reader as "the line breaks in my quote disappeared".
// The corpus is byte-pinned precisely so a change like this cannot happen quietly; it happened loudly,
// with a ruling behind it, and the new bytes are the record of it.
//
// #384 / ADR-160 stage 1: the GOLDEN CORPUS byte-pin. One fixture document exercising every construct in
// the walker inventory; the CURRENT DOM serialization and the CURRENT SafeHtml string are pinned as
// snapshots BEFORE the visitor extraction and must stay byte-stable through every migration stage
// (extract helpers → SafeHtml sink → DOM sink → delete old walks). A diff here = the refactor changed
// behaviour = stop. Fence-MACRO dispatch is deliberately absent from the corpus (mermaid mounts an async
// widget — nondeterministic in happy-dom); the registered-macro dispatch path keeps its dedicated pins in
// md-render.test.ts / server-render.test.ts (which stay green through the migration too).
const CORPUS = `---
tags: [alpha, "beta gamma"]
---

# H1 title

## H2 with **bold** and \`code\`

###### H6 small

para with **strong**, _em_, ~~strike~~, ==mark==, \`inline\`, a [safe link](https://example.com/x?a=1),
an [unsafe link](javascript:alert(1)), an [attachment](wks-attachment:abc-123), and a footnote[^one].
line one\\
line two

> quoted **deep**
>
> - inside list

- bullet a
- bullet b
  1. nested one
  2. nested two

---

| Head A | Head B |
| ------ | ------ |
| cell *i* | cell [l](https://e.com) |
| <b>raw</b> | plain |

\`\`\`
plain fence <not a tag>
\`\`\`

\`\`\`ts title="app.ts"
const x: number = 1;
\`\`\`

\`\`\`unknownlang
who knows
\`\`\`

:::unknowndir[Label]
inner **body** text
:::

:::note[Heads up]
callout body with \`code\` and a nested footnote[^inner]

[^inner]: nested def stays literal
:::

<div>html block stays literal</div>

<script>alert("xss")</script>

text with inline <img src=x onerror=alert(1)> html

[^one]: the first note with **bold**
[^one]: duplicate def — first wins
[^orphan]: never referenced
undefined ref here[^ghost]
`;

describe("#384 golden corpus (ADR-160 stage 1 — byte-stable through the visitor migration)", () => {
  it("DOM sink golden", () => {
    const d = document.createElement("div");
    d.appendChild(renderMarkdownToDom(CORPUS));
    expect(d.innerHTML).toMatchSnapshot();
  });

  it("SafeHtml sink golden (no registry — plain markdown)", () => {
    expect(renderMarkdownToHtml(CORPUS).value).toMatchSnapshot();
  });

  // #406 updated the DOM-sink snapshot on purpose: a table is now wrapped in its own horizontal
  // scroll box, so a wide table scrolls inside itself instead of widening the page. The SafeHtml sink
  // (server export) is unchanged — the box is a display concern of the app surfaces, and the exported
  // document keeps its plain <table>.
  // #472 updated this snapshot on purpose: the callout now emits its `[label]` as a title, which the
  // server renderer used to drop. A golden corpus is meant to make exactly that visible — the diff is
  // the feature, and the surrounding bytes stayed put.
  it("SafeHtml sink golden (builtin registry — directive dispatch incl. callout/details)", () => {
    const src = `:::note[Hi]\nnested **body**\n:::\n\n:::details[More]\nhidden\n:::\n\n:::columns\n:::column\nleft\n:::\n:::column\nright\n:::\n::::\n`;
    expect(renderMarkdownToHtml(src, builtinMacroRegistry()).value).toMatchSnapshot();
  });

  it("DOM sink golden (nested/tagged render — baseOffset threads #215 anchors)", () => {
    const d = document.createElement("div");
    d.appendChild(renderMarkdownToDom("para **x**\n\n:::unknowndir\ninner\n:::\n", 100));
    expect(d.innerHTML).toMatchSnapshot();
  });

  it("DOM sink golden (static mode — macro chips, no live dispatch)", () => {
    const d = document.createElement("div");
    d.appendChild(renderMarkdownToDom("before\n\n```mermaid\nflowchart TD\n```\n\nafter\n", undefined, { staticMacros: true }));
    expect(d.innerHTML).toMatchSnapshot();
  });
});
