import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./i18n"; // initialize i18next before the app renders
import "@fontsource/plus-jakarta-sans/600.css"; // brand wordmark (OFL); self-hosted
import "./styles/tokens.css";
import "./styles/print.css";
import "./styles/macro-modal.css";
import "./styles/table-edit.css"; // #86: table editor runs in the modal (outside CM baseTheme)
import "./styles/callout-icons.css"; // #158-C4: callout header icons (Lucide mask-image)

// StrictMode is intentional: it double-invokes effects in dev, which exercises
// the <Editor/> connect/destroy/reconnect path and surfaces any WS leak or ghost
// cursor immediately (see ADR-013 §verification).
//
// (The old benign dev-only "Cannot read properties of null (reading 'useId')" on
// StrictMode portal teardown was an Ark Combobox/Dialog artifact; it no longer
// reproduces after the shadcn/Radix migration — #142.)
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
