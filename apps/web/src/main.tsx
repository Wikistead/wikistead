import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/tokens.css";

// StrictMode is intentional: it double-invokes effects in dev, which exercises
// the <Editor/> connect/destroy/reconnect path and surfaces any WS leak or ghost
// cursor immediately (see ADR-013 §verification).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
