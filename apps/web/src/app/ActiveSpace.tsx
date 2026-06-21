import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

// The space whose page tree the sidebar shows. Source of truth chain:
//   1. when a page is open, PageRoute sets it to that page's spaceId (so opening a
//      page from anywhere — cross-space search, a share link — makes the sidebar
//      follow);
//   2. the space switcher sets it when browsing without a specific page;
//   3. localStorage seeds the initial default across sessions.
// It is deliberately NOT in the URL — the URL stays page-centric (/p/:pageId), and
// the active space is derived, so no routing/link changes were needed.
const KEY = "wks.activeSpace";

interface ActiveSpaceCtx {
  activeSpaceId: string | null;
  setActiveSpaceId: (id: string | null) => void;
}
const Ctx = createContext<ActiveSpaceCtx | null>(null);

export function useActiveSpace(): ActiveSpaceCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useActiveSpace must be used within <ActiveSpaceProvider>");
  return c;
}

export function ActiveSpaceProvider({ children }: { children: ReactNode }) {
  const [activeSpaceId, set] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const setActiveSpaceId = useCallback((id: string | null) => {
    set(id);
    try {
      if (id) localStorage.setItem(KEY, id);
    } catch {
      /* private mode — just won't persist */
    }
  }, []);
  return <Ctx.Provider value={{ activeSpaceId, setActiveSpaceId }}>{children}</Ctx.Provider>;
}
