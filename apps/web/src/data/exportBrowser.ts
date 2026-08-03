import { buildExportDocument, inlineTransientImages } from "./exportDocument";

// #85 / ADR-194 (Option B) slice 3: the ONE way a document leaves this app as a file — download and print
// take the same road, because two roads to paper is exactly the drift #85/#505/#207 kept re-discovering.
//
// The body is rendered with LIVE macros, unlike the print portal's static mode: a mermaid block that draws
// itself is the whole reason the browser is the one writing this file. Which means waiting — those renders
// are asynchronous — so the surface is settled before it is serialized.

// Render `md` into a detached-but-LAID-OUT host. Off-screen rather than display:none on purpose: a diagram
// renderer measures text, and inside a display:none subtree every measurement is zero, which produces a
// drawn-but-collapsed figure. Caller removes the host.
export interface ExportHosts {
  // #505 review rejection: the export rendered `renderMarkdownToDom(md)` with no host seams at all, so a
  // HOST-rendered diagram (plantuml goes to the server for its picture) had nobody to ask and fell back to
  // its source. On screen it is a figure. Passing the same seam the editor uses is what makes the file
  // agree with the page; anything the host cannot render still degrades to its source, as it does live.
  readonly diagram?: { render(lang: string, source: string): Promise<Blob | { ok: true; blob: Blob } | { ok: false; reason?: string } | null>; handles(lang: string): boolean };
}

async function renderBody(md: string, hosts?: ExportHosts): Promise<HTMLElement> {
  const { renderMarkdownToDom, withDiagramHost, withEmbedHost } = await import("../editor/macros/md-render");
  // #207 ③: with no embed seam the macro fell to its "this surface cannot show it" sentence, and a
  // saved file carried that sentence where the screen has content. A FILE cannot host a live iframe either
  // (that is what `exportFidelity: "degrade"` says), so the honest output is the link — produced by the
  // same builder the screen uses, taking its degrade branch on an empty allowlist.
  const { buildEmbedElement } = await import("../editor/macros/embed");
  const host = document.createElement("div");
  host.className = "wks-prose";
  host.setAttribute("data-export-staging", "");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:46rem;pointer-events:none;";
  document.body.appendChild(host);
  // #85 (review rejection ④, "the plantuml block came out as its source"): a HOST-rendered diagram is a
  // network round trip, and `settle` below only samples the markup for stillness with a 4s ceiling. A
  // renderer that answers in 4.1s therefore produced a file with the source card in it — silently, and
  // only sometimes, which is exactly the shape of a defect that survives every green test. So the
  // promises are TRACKED: the host is wrapped, every render it starts is remembered, and the document
  // is not serialized until they have all answered (or the cap below gives up).
  const pending: Promise<unknown>[] = [];
  const tracked = hosts?.diagram
    ? { handles: (l: string) => hosts.diagram!.handles(l),
        render: (l: string, src: string) => { const p = hosts.diagram!.render(l, src); pending.push(p.catch(() => null)); return p } }
    : null;
  withDiagramHost(tracked, () => withEmbedHost({ build: (url: string) => buildEmbedElement(url, []) }, () => {
    host.appendChild(renderMarkdownToDom(md));
  }));
  // The cap is generous because the alternative is a file that quietly lost a figure, and it only binds
  // when a renderer is genuinely slow — a normal render resolves long before it.
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((r) => setTimeout(r, DIAGRAM_BUDGET_MS)),
  ]);
  await settle(host);
  return host;
}

/** How long the export waits for host-rendered diagrams before giving up on them (#85 ④). */
const DIAGRAM_BUDGET_MS = 20_000;

// Wait for the asynchronous macro renders to stop changing the subtree. There is no completion signal to
// subscribe to — each macro fills itself in when its own renderer resolves — so this samples the markup
// until it stops moving, with a ceiling. A timeout yields whatever HAS drawn rather than nothing: a partly
// drawn document is worth more than a failed export, and the missing piece is visible in the result.
async function settle(host: HTMLElement, budgetMs = 4000, quietMs = 150): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, quietMs));
    const now = host.innerHTML;
    if (now === last) { stable += 1; if (stable >= 2) return } else { stable = 0; last = now }
  }
}

async function withDocument<T>(md: string, title: string, hosts: ExportHosts | undefined, use: (html: string) => T | Promise<T>): Promise<T> {
  const host = await renderBody(md, hosts);
  try {
    // Baked in AFTER settle: a host-rendered diagram lands as `<img src="blob:…">`, which resolves in this
    // session (so print worked) and in no other (so the saved file opened to a broken image —).
    await inlineTransientImages(host);
    return await use(buildExportDocument({ title, body: host }));
  } finally {
    host.remove();
  }
}

// Download the page as a standalone .html file.
export async function downloadBrowserExport(md: string, title: string, hosts?: ExportHosts): Promise<void> {
  await withDocument(md, title, hosts, (html) => {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(title || "Untitled").replace(/[\\/:*?"<>|]/g, "_")}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a turn of the loop: revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
}

// Print the same document. The frame is the browser's own print path — the document it prints is the file
// the download produces, byte for byte, so what someone sees on paper is what they would have received.
export async function printBrowserExport(md: string, title: string, hosts?: ExportHosts): Promise<void> {
  await withDocument(md, title, hosts, async (html) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);
    const remove = () => { if (iframe.parentNode) iframe.remove() };
    await new Promise<void>((resolve) => {
      iframe.addEventListener("load", () => resolve(), { once: true });
      iframe.srcdoc = html;
    });
    const win = iframe.contentWindow;
    if (!win) { remove(); return }
    win.addEventListener("afterprint", () => setTimeout(remove, 0), { once: true });
    try { win.focus(); win.print() } finally { setTimeout(remove, 60_000) }
  });
}
