import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { TooltipProvider } from "./components/ui/tooltip"; // #530: one delay for every React tooltip
import { installTooltipHost } from "./ui/tooltip-host"; // #530: the same tooltip for DOM built outside React
import "./i18n"; // initialize i18next before the app renders
import "@fontsource/plus-jakarta-sans/600.css"; // brand wordmark (OFL); self-hosted
// #158-C1 UI fonts (OFL, self-hosted woff2): Inter (Latin) + Noto Sans JP (JP) → Notion-grade UI.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/500.css";
import "@fontsource/noto-sans-jp/700.css";
// #173 / #158-C1: editor monospace font (OFL, self-hosted woff2 subset). Loads "UDEV Gothic" so the
// editor's --font-mono renders it (full-width = 2×half-width → vim columns stay exact for Japanese).
import "./assets/fonts/udev-gothic.css";
// #190 / ADR-090: code face — Wikistead Mono (a Source Code Pro OFL subset). Drives --font-code.
import "./assets/fonts/wikistead-mono.css";
import "./styles/tokens.css";
import "./styles/print.css";
import "./styles/ds-controls.css"; // #389 indicators painted by their own frame (device-pixel stable)
import "./styles/macro-modal.css";
import "./styles/callout-icons.css"; // #158-C4: callout header icons (Lucide mask-image)
import "./styles/prose.css"; // #381 / ADR-163: THE raw-tag prose sheet (.wks-prose) + shared value tokens
import "./styles/public.css"; // #227: prose styling for the anonymous public page body (outside CM)
import "katex/dist/katex.min.css"; // #158-C3: KaTeX math rendering (MIT, self-hosted)

// StrictMode is intentional: it double-invokes effects in dev, which exercises
// the <Editor/> connect/destroy/reconnect path and surfaces any WS leak or ghost
// cursor immediately (see ADR-013 §verification).
//
// (The old benign dev-only "Cannot read properties of null (reading 'useId')" on
// StrictMode portal teardown was an Ark Combobox/Dialog artifact; it no longer
// reproduces after the shadcn/Radix migration — #142.)
// #530: the delegated tooltip for non-React DOM (CodeMirror widgets, macro chrome). One document-level
// controller, installed before the first render so a widget built during mount is already covered.
installTooltipHost();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* #530: TooltipProvider carries the shared delay (TOOLTIP_DELAY_MS) for every React <Tooltip>. */}
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
