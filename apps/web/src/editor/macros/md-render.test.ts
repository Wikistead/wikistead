// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderMarkdownToDom } from "./md-render";

function root(src: string): HTMLElement {
  const d = document.createElement("div");
  d.appendChild(renderMarkdownToDom(src));
  return d;
}

describe("renderMarkdownToDom (#90 S0)", () => {
  it("renders common Markdown to elements", () => {
    const d = root("# Title\n\npara **bold** _i_ `c`\n\n- a\n- b\n");
    expect(d.querySelector("h1")?.textContent).toBe("Title");
    expect(d.querySelector("strong")?.textContent).toBe("bold");
    expect(d.querySelector("em")?.textContent).toBe("i");
    expect(d.querySelector("code")?.textContent).toBe("c");
    expect(d.querySelectorAll("ul li").length).toBe(2);
    expect(d.querySelector("p")?.textContent).toContain("para");
  });

  it("renders a safe link and DROPS a javascript: href (no anchor, text kept)", () => {
    const ok = root("[x](https://e.com)");
    expect(ok.querySelector("a")?.getAttribute("href")).toBe("https://e.com");
    expect(ok.querySelector("a")?.textContent).toBe("x");

    const bad = root("[x](javascript:alert(1))");
    expect(bad.querySelector("a")).toBeNull(); // dangerous scheme → not an anchor
    expect(bad.textContent).toContain("x"); // text preserved
  });

  it("renders raw HTML as LITERAL TEXT — no script/img element, no execution (XSS boundary)", () => {
    const d = root("<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)> there");
    expect(d.querySelector("script")).toBeNull();
    expect(d.querySelector("img")).toBeNull();
    expect(d.textContent).toContain("<script>"); // shown as literal text, not parsed as HTML
  });

  it("never uses innerHTML — angle brackets/ampersands in text are escaped entities", () => {
    const d = root("a < b & c > d");
    expect(d.innerHTML).toContain("&lt;");
    expect(d.innerHTML).toContain("&amp;");
    expect(d.querySelector("p")?.textContent).toBe("a < b & c > d"); // round-trips as text
  });

  it("a fenced code block renders as <pre><code> with its text verbatim (no highlight HTML)", () => {
    const d = root("```js\nconst x = 1 < 2;\n```\n");
    const code = d.querySelector("pre > code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("const x = 1 < 2;");
    expect(code?.querySelector("*")).toBeNull(); // plain text, no nested HTML
  });
});
