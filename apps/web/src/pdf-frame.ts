// #273 / ADR-120 (Option B): the pdf.js renderer that runs INSIDE the attachment PDF viewer's iframe. The
// iframe is `sandbox="allow-scripts"` with NO `allow-same-origin`, so this document executes in an OPAQUE
// origin — it cannot reach the parent app's DOM, cookies, or storage, and cannot fetch with the user's
// credentials. The parent (which already view-gate-fetched the sniffed-PDF bytes) posts the ArrayBuffer in;
// this renders it to page canvases. Defense-in-depth: even if a malformed PDF triggered a pdf.js parser bug,
// the blast radius is this throwaway opaque-origin frame, never the app origin (the containment
// decision — important once #274 lets anonymous editors drop attacker-controlled PDF bytes into a page).
//
// pdf.js is a pure BYTE→PIXEL parser here: no eval (pdfjs-dist v6 removed the eval path), no ScriptingManager
// / OpenAction (PDF-embedded JavaScript never runs), no text/annotation layer, no external fetch — just
// getDocument({ data }) + page.render onto a <canvas>.
import * as pdfjs from "pdfjs-dist";

// #273 pdf.js v6.1.200 calls the TC39 "Map/Set upsert" methods (getOrInsertComputed / getOrInsert),
// which are still behind a flag in V8 and ABSENT in current Chromium (~149). Without them page.render throws
// "getOrInsertComputed is not a function" and the PDF never paints — in the e2e AND in a real browser. Define
// them (the main thread) and prepend the same source to the worker blob below (the worker is a separate realm).
// Standards-track proposal semantics; a no-op once browsers ship it natively.
const UPSERT_POLYFILL = `(function(){for(var C of [Map,WeakMap]){var p=C.prototype;
if(!p.getOrInsert){p.getOrInsert=function(k,d){if(this.has(k))return this.get(k);this.set(k,d);return d;};}
if(!p.getOrInsertComputed){p.getOrInsertComputed=function(k,f){if(this.has(k))return this.get(k);var v=f(k);this.set(k,v);return v;};}}})();`;
// eslint-disable-next-line @typescript-eslint/no-implied-eval
new Function(UPSERT_POLYFILL)();
// #273 the worker CANNOT be a URL here. This document runs in an OPAQUE origin (sandbox=allow-scripts,
// no allow-same-origin), which has NO same-origin — and `new Worker(url)` requires a same-origin (or blob/data)
// script, so a URL worker is blocked regardless of CORS. Inline the worker SOURCE into this chunk (`?raw`) and
// hand pdf.js a BLOB-URL module worker, which IS constructible from an opaque origin. (This also removes a
// second cross-origin fetch — only the entry module itself needs the dev ACAO header, see vite.config.ts.)
import workerSource from "pdfjs-dist/build/pdf.worker.min.mjs?raw";

// Prepend the upsert polyfill to the worker source too (a Worker is a separate realm — the main-thread define
// above doesn't reach it, and the worker's pdf.js uses the same methods).
const workerBlobUrl = URL.createObjectURL(new Blob([UPSERT_POLYFILL + "\n" + workerSource], { type: "text/javascript" }));
pdfjs.GlobalWorkerOptions.workerSrc = workerBlobUrl;

const msg = document.getElementById("msg")!;
const pages = document.getElementById("pages")!;

async function render(data: ArrayBuffer): Promise<void> {
  msg.textContent = "Loading…";
  pages.replaceChildren();
  try {
    // pdfjs-dist v6 removed the eval path entirely (no isEvalSupported option needed) — no PDF-embedded JS runs.
    const doc = await pdfjs.getDocument({ data }).promise;
    msg.style.display = "none";
    const scale = Math.min(2, (window.innerWidth - 24) / 612); // fit width (612pt = US-Letter), cap DPR-ish
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: Math.max(1, scale) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      pages.appendChild(canvas);
      // pdf.js v6: pass the CANVAS element (the primary param); `canvasContext` is deprecated and passing both
      // trips an internal private-field access. The context is derived from the canvas.
      await page.render({ canvas, viewport }).promise;
    }
    // let the parent size the frame to the content
    try { window.parent?.postMessage({ type: "pdf-frame:rendered", pages: doc.numPages, height: pages.scrollHeight }, "*"); } catch { /* parent gone */ }
  } catch {
    msg.style.display = "";
    msg.textContent = "Could not display this PDF.";
  }
}

// Accept the bytes ONLY from our embedder (the parent window). Origin is opaque, so we can't check the origin
// string; source identity (event.source === parent) is the gate. A message without ArrayBuffer bytes is ignored.
window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const data = (e.data as { type?: string; bytes?: ArrayBuffer } | ArrayBuffer);
  const bytes = data instanceof ArrayBuffer ? data : data?.bytes;
  if (bytes instanceof ArrayBuffer) void render(bytes);
});

// Tell the parent we're ready to receive the bytes (the parent waits for this before posting).
try { window.parent?.postMessage({ type: "pdf-frame:ready" }, "*"); } catch { /* no parent */ }
