import type { FenceMacro, MacroContext, MacroModalController, HostEphemeralCollab, MacroSource } from "./registry";
import { asMacroSource } from "./registry";
import { writeLocalElements, readSceneElements, allElements, reconcile, elementsMap } from "./excalidraw-collab";
import { html } from "./safe-html";

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

export const excalidrawMacro: FenceMacro = {
  kind: "fence",
  lang: "excalidraw",
  exportFidelity: "preserve", // the JSON is a standard code fence → lossless round-trip
  summary: () => "Excalidraw drawing",
  slash: { labelKey: "palette.excalidraw", keywords: "diagram draw whiteboard sketch excalidraw", insert: "```excalidraw\n\n```", caret: 14 },
  liveRender(body) {
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-excalidraw";
    el.setAttribute("data-testid", "macro-excalidraw");
    const scene = parseScene(body);
    if (!scene.elements.length) {
      el.classList.add("cm-lp-macro-empty");
      el.textContent = "Empty drawing — click to edit";
      return el;
    }
    void loadExcalidraw().then(async ({ exportToSvg }) => {
      try {
        const svg = await exportToSvg({
          elements: scene.elements,
          appState: { ...scene.appState, exportBackground: false },
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
  htmlRender: () => html`<div class="excalidraw-drawing">[Excalidraw drawing]</div>`,
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
        let api: any = null;
        let applyingRemote = false;
        let unobserve: (() => void) | null = null;

        const onChange = (elements: any, appState: any, files: any) => {
          try {
            current = asMacroSource(excal.serializeAsJSON(elements, appState, files, "local"));
          } catch {
            /* keep the last good serialization */
          }
          if (doc && !applyingRemote) writeLocalElements(doc, elements); // includes isDeleted → deletions propagate
        };

        root.render(
          React.createElement(excal.Excalidraw as any, {
            initialData: { elements: scene.elements, appState: { ...scene.appState, theme: ctx.theme }, files: scene.files, scrollToContent: true },
            onChange,
            theme: ctx.theme,
            ...(doc ? { excalidrawAPI: (a: any) => { api = a; } } : {}),
          }),
        );

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
          destroy: () => { unobserve?.(); root.unmount(); },
        };
      },
    },
  },
};
