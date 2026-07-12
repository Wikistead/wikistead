import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SocialIcon } from "./SocialIcon";

// #281 review: each social sign-in button must carry its provider's brand mark (inline SVG — no external
// fetch, so the self-contained/CSP posture holds). This proves the mark renders for every known provider and
// that an unknown slug renders nothing (rather than a broken/empty box). The buttons themselves stay covered
// by the server login-options gating (social-login-281.test.ts); here we only assert the icon layer.
// (createElement, not JSX, so this stays a .test.ts the web vitest config already picks up.)
const render = (slug: string) => renderToStaticMarkup(createElement(SocialIcon, { slug }));

describe("SocialIcon (#281)", () => {
  for (const slug of ["google", "github", "microsoft"]) {
    it(`renders an <svg> brand mark for ${slug}`, () => {
      const html = render(slug);
      expect(html).toContain("<svg");
      expect(html).toContain('aria-hidden="true"'); // decorative — the provider name is the readable label
    });
  }

  it("renders GitHub's mark with currentColor so it tracks the button foreground (light/dark)", () => {
    expect(render("github")).toContain('fill="currentColor"');
  });

  it("renders Google's and Microsoft's fixed brand colours", () => {
    expect(render("google")).toContain("#4285F4"); // Google blue
    expect(render("microsoft")).toContain("#F25022"); // MS red tile
  });

  it("renders nothing for an unknown provider (no broken/empty box)", () => {
    expect(render("myspace")).toBe("");
  });
});
