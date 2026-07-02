import { useCallback, useState } from "react";

// #192 / ADR-091: table-of-contents preferences — on/off (default ON) + depth (default H3). v1 is
// DEVICE-LOCAL (localStorage), which works for members AND guests (a guest has no account); syncing a
// logged-in user's choice to their account settings (ADR-020) is a follow-up. Global (not per-page):
// the same keys apply to every page. Mirrors the theme/font device-local pref pattern.
const ON_KEY = "wks.tocOn";
const DEPTH_KEY = "wks.tocDepth";

function loadOn(): boolean {
  try { return localStorage.getItem(ON_KEY) !== "0"; } catch { return true; } // default ON
}
function loadDepth(): number {
  try {
    const v = Number(localStorage.getItem(DEPTH_KEY));
    return v >= 1 && v <= 6 ? v : 3;
  } catch { return 3; } // default H1–H3
}

export function useTocPref() {
  const [on, setOnState] = useState<boolean>(loadOn);
  const [depth, setDepthState] = useState<number>(loadDepth);
  const setOn = useCallback((v: boolean) => {
    setOnState(v);
    try { localStorage.setItem(ON_KEY, v ? "1" : "0"); } catch { /* private mode */ }
  }, []);
  const setDepth = useCallback((d: number) => {
    setDepthState(d);
    try { localStorage.setItem(DEPTH_KEY, String(d)); } catch { /* private mode */ }
  }, []);
  return { on, setOn, depth, setDepth };
}
