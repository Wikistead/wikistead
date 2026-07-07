import type { FenceMacro, MacroContext, MacroModalController, HostEphemeralCollab, MacroSource } from "./registry";
import { asMacroSource } from "./registry";
import { writeLocalElements, readSceneElements, allElements, reconcile, elementsMap } from "./excalidraw-collab";
import { excalidrawHtmlRender } from "@wikistead/macro-render"; // #85: export htmlRender is shared, single source
import i18n from "../../i18n"; // #174 comment 911: empty-state text is localized (en/ja), points at the ✎ button

// ```excalidraw — body is an Excalidraw scene JSON. The PREVIEW (liveRender) uses
// Excalidraw's NON-React exportToSvg, so no React enters CodeMirror (ADR-013). The
// mouse EDITOR (richEditUI: modal) mounts the real <Excalidraw> React component in a
// plain-DOM overlay (a separate React tree, outside CM). Both are lazy-loaded (the
// library is large). Excalidraw + its deps are MIT/permissive (license:check gate).

// eslint-disable: scene JSON is external/dynamic; we keep it loosely typed.
type Scene = { elements: any[]; appState: any; files: any };

let modP: Promise<typeof import("@excalidraw/excalidraw")> | null = null;
// Load the component AND its stylesheet (0.17+ requires it — without it the UI renders
// unstyled, e.g. a giant padlock/toolbar icon). Both are lazy so they stay out of the
// main bundle. The CSS import is a side effect (Vite injects it).
const loadExcalidraw = () =>
  (modP ??= Promise.all([import("@excalidraw/excalidraw"), import("@excalidraw/excalidraw/index.css")]).then(([m]) => m));

let reactP: Promise<{ React: typeof import("react"); createRoot: (typeof import("react-dom/client"))["createRoot"] }> | null = null;
const loadReact = () =>
  (reactP ??= Promise.all([import("react"), import("react-dom/client")]).then(([React, rd]) => ({ React, createRoot: rd.createRoot })));

function parseScene(body: string): Scene {
  try {
    const d = JSON.parse(body);
    return { elements: Array.isArray(d.elements) ? d.elements : [], appState: d.appState ?? {}, files: d.files ?? {} };
  } catch {
    return { elements: [], appState: {}, files: {} };
  }
}

// #200: Excalidraw's default stroke colours (light = #1e1e1e, dark = #e3e3e8). A stroke left at the
// default is meant to follow the theme, but the absolute value is stored, so a theme switch strands it.
const EXCALIDRAW_DEFAULT_STROKES = new Set(["#1e1e1e", "#e3e3e8"]);
const themeDefaultStroke = (dark: boolean) => (dark ? "#e3e3e8" : "#1e1e1e");

// Remap any element whose strokeColor is a known Excalidraw DEFAULT to the current display theme's
// default, so default strokes stay visible after a theme switch. User-picked (non-default) colours are
// returned untouched. Pure — returns a new array only where a remap is needed.
export function themeAdaptStrokes(elements: any[], dark: boolean): any[] {
  const target = themeDefaultStroke(dark);
  return elements.map((e) => {
    const s = typeof e?.strokeColor === "string" ? e.strokeColor.toLowerCase() : null;
    return s && EXCALIDRAW_DEFAULT_STROKES.has(s) && s !== target ? { ...e, strokeColor: target } : e;
  });
}

export const excalidrawMacro: FenceMacro = {
  kind: "fence",
  lang: "excalidraw",
  exportFidelity: "preserve", // the JSON is a standard code fence → lossless round-trip
  summary: () => "Excalidraw drawing",
  slash: { labelKey: "palette.excalidraw", keywords: "diagram draw whiteboard sketch excalidraw", insert: "```excalidraw\n\n```", caret: 14 },
  liveRender(body, ctx) {
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-excalidraw";
    el.setAttribute("data-testid", "macro-excalidraw");
    const scene = parseScene(body);
    if (!scene.elements.length) {
      el.classList.add("cm-lp-macro-empty");
      el.textContent = i18n.t("macro.excalidrawEmpty");
      return el;
    }
    const dark = ctx.theme === "dark";
    void loadExcalidraw().then(async ({ exportToSvg }) => {
      try {
        const svg = await exportToSvg({
          // #200: make DEFAULT strokes follow the DISPLAY theme. Excalidraw stores absolute stroke
          // colours and shows the dark theme via a render-time invert filter; exportWithDarkMode applies
          // that filter to the SVG. But a default stroke drawn in one theme keeps its absolute colour,
          // so after a theme switch it goes low-contrast (light-drawn #1e1e1e vanishes on dark; a
          // dark-drawn light stroke vanishes on light). We instead remap any element whose strokeColor
          // is a known Excalidraw default to the CURRENT theme's default (themeAdaptStrokes) and DISABLE
          // exportWithDarkMode (so our explicit colours aren't inverted again). User-picked colours are
          // left untouched — only the theme-default strokes adapt.
          elements: themeAdaptStrokes(scene.elements, dark),
          appState: { ...scene.appState, exportBackground: false, theme: ctx.theme, exportWithDarkMode: false },
          files: scene.files,
        } as any);
        el.appendChild(svg);
      } catch {
        el.classList.add("cm-lp-macro-error");
        el.textContent = "Invalid Excalidraw drawing";
      }
    });
    return el;
  },
  // M3 wires HTML export. Excalidraw renders in the browser; the static form is a
  // placeholder (a server-side SVG pre-render is an M3 option). The JSON round-trips in
  // .md regardless (it's a code fence).
  htmlRender: excalidrawHtmlRender,
  richEditUI: {
    present: "modal",
    collab: true, // #92 / ADR-093: opt into the host's ephemeral collab seam (level-2 co-editing)
    editor: {
      async mount(container: HTMLElement, body: MacroSource, ctx: MacroContext, hostCollab?: HostEphemeralCollab): Promise<MacroModalController> {
        const [{ React, createRoot }, excal] = await Promise.all([loadReact(), loadExcalidraw()]);
        const scene = parseScene(body);
        let current: MacroSource = body; // latest serialized scene (written back on save)
        const root = createRoot(container);
        // #92: ephemeral collab (ADR-093). While the modal is open, scene elements sync through the
        // host's ephemeral Y.Doc (a Y.Map keyed by element id, merged by version — excalidraw-collab).
        // Local edits → writeLocalElements; remote map changes → updateScene(reconcile). `applyingRemote`
        // breaks the updateScene→onChange echo. On close the merged scene is flushed to the fence (getBody)
        // and the room is torn down by the host. No collab session → the M1 single-user modal.
        const doc = hostCollab?.doc;
        // #92 canvas cursors: the ephemeral room's awareness (host-injected; carries each peer's user
        // identity + live pointer). Cast to the minimal shape we use — the macro host-API stays {theme};
        // this is the separate host collab seam. Null in the single-user modal (no cursors).
        const awareness = (hostCollab?.awareness ?? null) as {
          clientID: number;
          setLocalStateField(field: string, value: unknown): void;
          getStates(): Map<number, Record<string, any>>;
          on(ev: "change", cb: () => void): void;
          off(ev: "change", cb: () => void): void;
        } | null;
        let api: any = null;
        let applyingRemote = false;
        let unobserve: (() => void) | null = null;
        let unobserveCursors: (() => void) | null = null;

        const onChange = (elements: any, appState: any, files: any) => {
          try {
            current = asMacroSource(excal.serializeAsJSON(elements, appState, files, "local"));
          } catch {
            /* keep the last good serialization */
          }
          if (doc && !applyingRemote) writeLocalElements(doc, elements); // includes isDeleted → deletions propagate
        };

        // #92 canvas cursors: publish this user's live pointer (scene coords) onto the ephemeral
        // awareness so peers can render our cursor. Display-only (never touches the doc/scene).
        const onPointerUpdate = (p: { payload?: { pointer?: { x: number; y: number }; button?: string } }) => {
          if (!awareness || !p?.payload?.pointer) return;
          try { awareness.setLocalStateField("pointer", { x: p.payload.pointer.x, y: p.payload.pointer.y, button: p.payload.button ?? "up" }); } catch { /* gone */ }
        };

        root.render(
          React.createElement(excal.Excalidraw as any, {
            initialData: { elements: scene.elements, appState: { ...scene.appState, theme: ctx.theme }, files: scene.files, scrollToContent: true },
            onChange,
            theme: ctx.theme,
            ...(doc ? { excalidrawAPI: (a: any) => { api = a; } } : {}),
            ...(awareness ? { onPointerUpdate } : {}),
          }),
        );

        // #92 canvas cursors: mirror remote peers' awareness (pointer + user identity) into Excalidraw's
        // native `collaborators` map, so their cursors render on the canvas with the SAME colour/label as
        // the page's yCollab carets (unified multiplayer design). Fires on every awareness change (the
        // ephemeral room's — NOT the page awareness, so no interference with page cursor sync).
        if (awareness) {
          const syncCollaborators = () => {
            if (!api) return;
            const collaborators = new Map<string, unknown>();
            awareness.getStates().forEach((state, clientId) => {
              if (clientId === awareness.clientID) return; // exclude self
              const ptr = state?.["pointer"] as { x: number; y: number; button?: string } | undefined;
              const u = state?.["user"] as { name?: string; color?: string } | undefined;
              if (!ptr) return;
              const color = u?.color ?? "#888";
              collaborators.set(String(clientId), {
                pointer: { x: ptr.x, y: ptr.y },
                button: ptr.button === "down" ? "down" : "up",
                username: u?.name ?? "",
                color: { background: color, stroke: color }, // unified with the yCollab caret colour
              });
            });
            try { api.updateScene({ collaborators }); } catch { /* excalidraw not ready */ }
          };
          awareness.on("change", syncCollaborators);
          unobserveCursors = () => awareness.off("change", syncCollaborators);
        }

        if (doc) {
          const map = elementsMap(doc);
          const getAll = () => (api?.getSceneElementsIncludingDeleted?.() ?? api?.getSceneElements?.() ?? []);
          const applyRemote = () => {
            if (!api) { requestAnimationFrame(applyRemote); return; }
            applyingRemote = true;
            try { api.updateScene({ elements: reconcile(getAll(), allElements(doc)) as any }); }
            finally { applyingRemote = false; }
          };
          if (map.size === 0) writeLocalElements(doc, scene.elements); // first joiner seeds from the fence
          else applyRemote(); // a later joiner adopts the shared scene
          const obs = () => { if (!applyingRemote) applyRemote(); };
          map.observe(obs);
          unobserve = () => map.unobserve(obs);
        }

        return {
          // On close, flush the CONVERGED scene from the shared doc (last write wins across editors),
          // clean of tombstones (readSceneElements), so the fence holds the final drawing.
          getBody: () => {
            if (doc && api) {
              try { return asMacroSource(excal.serializeAsJSON(readSceneElements(doc) as any, api.getAppState(), api.getFiles(), "local")); } catch { /* fall through */ }
            }
            return current;
          },
          destroy: () => { unobserve?.(); unobserveCursors?.(); root.unmount(); },
        };
      },
    },
  },
};
