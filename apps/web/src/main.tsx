import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./i18n"; // initialize i18next before the app renders
import "@fontsource/plus-jakarta-sans/600.css"; // brand wordmark (OFL); self-hosted
import "./styles/tokens.css";
import "./styles/print.css";
import "./styles/macro-modal.css";

// StrictMode is intentional: it double-invokes effects in dev, which exercises
// the <Editor/> connect/destroy/reconnect path and surfaces any WS leak or ghost
// cursor immediately (see ADR-013 §verification).
//
// TODO(web): a benign dev-only "Cannot read properties of null (reading
//   'useId')" can log once during StrictMode's portal teardown (Ark
//   Combobox/Dialog). React is a single copy (not a duplicate-React bug) and it
//   cannot occur in production (no StrictMode double-invoke there). Revisit only
//   if it appears in a production build or becomes noisy.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
