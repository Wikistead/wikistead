// #273 / ADR-120 (Option B): the pdf.js renderer that runs INSIDE the attachment PDF viewer's iframe. The
// iframe is `sandbox="allow-scripts"` with NO `allow-same-origin`, so this document executes in an OPAQUE
// origin — it cannot reach the parent app's DOM, cookies, or storage, and cannot fetch with the user's
// credentials. The parent (which already view-gate-fetched the sniffed-PDF bytes) posts the ArrayBuffer in;
// this renders it to page canvases. Defense-in-depth: even if a malformed PDF triggered a pdf.js parser bug,
// the blast radius is this throwaway opaque-origin frame, never the app origin (thecontainment
// decision — important once #274 lets anonymous editors drop attacker-controlled PDF bytes into a page).
//
// pdf.js is a pure BYTE→PIXEL parser here: no eval (pdfjs-dist v6 removed the eval path), no ScriptingManager
// / OpenAction (PDF-embedded JavaScript never runs), no text/annotation layer, no external fetch — just
// getDocument({ data }) + page.render onto a <canvas>.
import * as pdfjs from "pdfjs-dist";
// The worker is bundled as a same-file module URL so it loads from THIS origin (opaque frames can still load
// same-origin module workers spawned from their own document).
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

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
      const ctx = canvas.getContext("2d");
      if (ctx) await page.render({ canvas, canvasContext: ctx, viewport }).promise;
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
