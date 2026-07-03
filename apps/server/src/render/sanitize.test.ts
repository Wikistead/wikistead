import { describe, it, expect } from "vitest";
import { sanitizeExportHtml, SANITIZER_POLICY_VERSION } from "./sanitize";

// #85 / ADR-059 anti-tests: the server sanitizer is the SINGLE trust boundary. These assert the
// confirmed policy — script/handlers/js: URLs gone, inline style stripped, no inline SVG, data:
// limited to raster images, raw HTML (incl. inside a `:::table` cell) neutralised in the final pass.
describe("sanitizeExportHtml — XSS anti-tests (ADR-059)", () => {
  it("removes <script> entirely", () => {
    const out = sanitizeExportHtml(`<p>hi</p><script>alert(1)</script>`);
    expect(out).toContain("hi");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  it("strips event-handler attributes (onerror/onclick)", () => {
    const out = sanitizeExportHtml(`<img src="x" onerror="alert(1)"><div onclick="steal()">x</div>`);
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out.toLowerCase()).not.toContain("onclick");
    expect(out).not.toContain("alert(1)");
  });

  it("drops javascript: URLs on href", () => {
    const out = sanitizeExportHtml(`<a href="javascript:alert(1)">x</a>`);
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  it("strips inline style entirely (class-only)", () => {
    const out = sanitizeExportHtml(`<p style="position:fixed;top:0" class="callout">x</p>`);
    expect(out).not.toContain("style=");
    expect(out).toContain('class="callout"'); // class survives — the styling channel
  });

  it("removes a <script> inside a :::table cell in the FULL final pass (raw passthrough is zero)", () => {
    // The table-model allowlist runs upstream, but the final sanitizer must also neutralise raw HTML
    // — proving no cell content can smuggle script even after the table allowlist.
    const tableHtml = `<table><tbody><tr><td><script>alert(document.cookie)</script>cell</td></tr></tbody></table>`;
    const out = sanitizeExportHtml(tableHtml);
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("document.cookie");
    expect(out).toContain("cell"); // benign text preserved
    expect(out.toLowerCase()).toContain("<table"); // the table structure itself is allowed
  });
});

describe("sanitizeExportHtml — data: scheme granularity (ADR-059)", () => {
  it("allows data:image/png on <img>", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const out = sanitizeExportHtml(`<img src="${png}" alt="d">`);
    expect(out).toContain(png);
  });

  it("rejects data:image/svg+xml on <img>", () => {
    const out = sanitizeExportHtml(`<img src="data:image/svg+xml,%3Csvg%3E" alt="d">`);
    expect(out).not.toContain("svg+xml");
  });

  it("rejects data:text/html on href", () => {
    const out = sanitizeExportHtml(`<a href="data:text/html,<script>alert(1)</script>">x</a>`);
    expect(out).not.toContain("data:text/html");
    expect(out.toLowerCase()).not.toContain("<script");
  });
});

describe("sanitizeExportHtml — no inline SVG (mermaid/excalidraw degrade)", () => {
  it("strips a stray <svg>/<foreignObject> reaching the sanitizer", () => {
    const out = sanitizeExportHtml(`<div><svg><foreignObject><script>alert(1)</script></foreignObject></svg></div>`);
    expect(out.toLowerCase()).not.toContain("<svg");
    expect(out.toLowerCase()).not.toContain("foreignobject");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).toContain("<div>");
  });
});

describe("sanitizeExportHtml — MathML (KaTeX output:mathml) is allowed", () => {
  it("keeps MathML elements (namespace-aware)", () => {
    const out = sanitizeExportHtml(`<math><mrow><mi>x</mi><mo>=</mo><mn>1</mn></mrow></math>`);
    expect(out.toLowerCase()).toContain("<math");
    expect(out.toLowerCase()).toContain("<mi");
  });

  it("neutralises a javascript: xlink:href inside MathML (maction)", () => {
    const out = sanitizeExportHtml(`<math><maction xlink:href="javascript:alert(1)"><mi>x</mi></maction></math>`);
    expect(out.toLowerCase()).not.toContain("javascript:");
  });
});

describe("sanitizeExportHtml — raw markdown HTML block", () => {
  it("removes a raw <div onclick=…> block in the final output", () => {
    const out = sanitizeExportHtml(`<div onclick="steal()">click me</div>`);
    expect(out.toLowerCase()).not.toContain("onclick");
    expect(out).toContain("click me");
  });
});

describe("policy version", () => {
  it("exposes a numeric sanitizer policy version for cache-busting", () => {
    expect(typeof SANITIZER_POLICY_VERSION).toBe("number");
    expect(SANITIZER_POLICY_VERSION).toBeGreaterThanOrEqual(1);
  });
});
