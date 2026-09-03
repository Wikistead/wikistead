// The standing rendering-QA body, as a module rather than a `.md` fixture.
//
// It used to be `fixtures/torture-page.md`. That file shipped for two weeks as 119 lines of Japanese
// QA notes (#1059), and the publication carries every historical version of a path it publishes — so
// the English rewrite fixed the tip and left the Japanese in reach of `git show`. A module is a
// different path with no such history, and the publication drops the old one outright.
//
// §12 keeps its half-width kana and combining dakuten: they are the rendering canary, the input this
// fixture exists to exercise. Inside a template literal they are DATA, which is the line #795 draws
// (a string is product data; prose is not).
export const TORTURE_PAGE = String.raw`# Rendering QA: the torture page
Every rendering pattern that has broken before, in one body. **Each section opens with what is
expected.** Check it in Live / Reading / view / published / print as changes land.

## 1. Nested directives (the outer one must not close early; every nested one must render)
Expected: both tabs visible, no \`:::\` leaking into the body, the callout inside a tab gets its box
(tint + colour bar), the table inside a tab gets its rules.

::::tabs
:::tab[Tab 1]
Tab 1 body. **bold** and \`code\`.
:::
:::tab[Tab 2 (hidden at first)]

\`\`\`mermaid
flowchart TD
  A[Start] --> B{Branch}
  B -->|yes| C[A node with a long label, to take up width]
  B -->|no| D[Other route]
  C --> E[End]
  D --> E
\`\`\`

| Col A | Col B | Col C |
| - | - | - |
| nested table | 1 | 2 |

:::warning[Callout inside a tab]
The box, icon and label colour must be there outside the editor too.
:::
:::
::::

## 2. Three tall mermaid diagrams in a row (first render, motion, height drift)
Expected: all three render on first paint (appearing only after a click is the bug). vim's j/k crosses
each diagram in one stop.

\`\`\`mermaid
flowchart TD
  1A[Diagram 1] --> 1B[middle] --> 1C[lower] --> 1D[lower still] --> 1E[end]
\`\`\`

\`\`\`mermaid
flowchart TD
  2A[Diagram 2] --> 2B[middle] --> 2C[lower] --> 2D[lower still] --> 2E[end]
\`\`\`

\`\`\`mermaid
flowchart TD
  3A[Diagram 3] --> 3B[middle] --> 3C[lower] --> 3D[lower still] --> 3E[end]
\`\`\`

## 3. A plain task list (checkboxes)
Expected: clickable in edit. Clickable in view too (a known bug currently leaves view inert — confirm
here once it is fixed). Enter continues a \`- [ ]\`.
- [x] done task
- [ ] open task
  - [ ] nested task
1. [ ] ordered task

## 4. Maths (display atom, motion)
Expected: the block formula renders and j/k crosses it in one stop. The inline formula $e^{i\\pi}+1=0$
sits in the sentence.
$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

## 5. Code-fence attributes
Expected: the filename tab, line numbers, the second line highlighted. Copy takes the body only.
\`\`\`ts title=example.ts {2}
const a = 1;
const highlighted = 2; // this line is highlighted
const c = 3;
\`\`\`

## 6. Links
Expected: the external link autolinks, the internal link navigates, and the **dead link** below says
"not found" when clicked (struck through once that lands).
External: https://example.com/path?q=1
Internal (this page): [this page](/p/c985270e-ec4c-4aab-a3a6-a582072ecd93)
Dead: [a page that was removed](/p/00000000-0000-0000-0000-000000000000)

## 7. Images (a lone line is centred, an inline one flows)
Expected: the standalone image below is **centred**.
![red dot](wks-attachment:1952c165-07b1-4c5f-aaad-1853483c4534)
The inline image on this line ![dot](wks-attachment:1952c165-07b1-4c5f-aaad-1853483c4534) mixes into
the sentence **small**, and is not centred.

## 8. XSS canaries (every one must stay inert text)
Expected: no dialog, no image or script executes, all of it visible as plain characters.
<script>window.__torture=1</script>
<img src=x onerror="window.__t2=1">
[a js link](javascript:alert(1))

| in a cell | <img src=x onerror=alert(2)> |
| - | - |
| a | b |

## 9. Width and wrapping
Expected: a wide table scrolls **on its own**, not the whole page. A long word wraps.
| c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 | c9 | c10 | c11 | c12 |
| - | - | - | - | - | - | - | - | - | - | - | - |
| a longer cell body | b | c | d | e | f | g | h | i | j | k | l |

longwordxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

## 10. Quotes and rules
> quote, one level
>> quote, two levels (nested)

---

## 11. Other diagram kinds
Expected: excalidraw is an empty placeholder (click to open). plantuml **degrades to its source** when
no renderer is configured, rather than erroring.
\`\`\`excalidraw
\`\`\`

\`\`\`plantuml
Alice -> Bob: hello
\`\`\`

## 12. Emoji, combining marks and a mixed CJK heading 🎌
Text: 👨‍👩‍👧‍👦 family emoji (ZWJ), が゙ (combining dakuten), ｱｲｳ half-width kana.

The end (this page is the standing QA body — do not delete it).
`
