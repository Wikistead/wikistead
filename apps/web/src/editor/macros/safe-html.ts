// SafeHtml — the macro export/SSR XSS boundary as a COMPILE-TIME guarantee (ADR-045 / #88,
// ADR-025 Step 4). A macro's `htmlRender` returns `SafeHtml`, not `string`, so a macro CANNOT
// return raw concatenated HTML by accident: the value must be built through `html`` (which
// escapes every interpolation) or the audited, greppable `unsafeHtml` escape hatch. This turns
// the trust boundary from a convention ("remember to escape") into a type the compiler enforces
// — the same hardening applied to the narrow host-API elsewhere in the registry.
//
// Runtime shape: a tiny wrapper class (not a bare branded string) so `html`` can splice an
// ALREADY-safe fragment verbatim while escaping plain strings — composition without double
// escaping (columns/tabs wrap per-item SafeHtml). The server HTML pipeline (#85) reads `.value`.

export class SafeHtml {
  // Constructed only via the producers below. The @internal marker keeps callers honest — new
  // SafeHtml(x) is as auditable as unsafeHtml(x); first-party macros (M1/M2, ADR-023) go through
  // html``/unsafeHtml. A future user-macro sandbox (Stage 2) can lock this down further.
  /** @internal */ constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

// Escape the five HTML-significant characters. Single source of truth (was duplicated across
// five macro files). Escapes quotes too so it is safe inside an attribute value, not just text.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The ordinary producer: a tagged template that ESCAPES every `${}` interpolation, so building
// HTML from dynamic parts is safe by construction. A nested `SafeHtml` interpolation is spliced
// verbatim (already safe → no double escaping), which is how container macros compose per-item
// fragments. A number is stringified then escaped.
export function html(strings: TemplateStringsArray, ...values: (string | number | SafeHtml)[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    out += (v instanceof SafeHtml ? v.value : escapeHtml(String(v))) + (strings[i + 1] ?? "");
  }
  return new SafeHtml(out);
}

// Join already-safe fragments (e.g. `items.map(i => html`…`)`), preserving safety.
export function joinSafe(parts: readonly SafeHtml[], sep = ""): SafeHtml {
  return new SafeHtml(parts.map((p) => p.value).join(sep));
}

// The AUDITED escape hatch: wrap a string that is ALREADY safe HTML by another means — content
// the server sanitizer (#85) has cleaned, or a macro whose body is trusted HTML it emits verbatim
// (`:::table`). Greppable on purpose: every call is a place a reviewer must confirm is safe. Do
// NOT use it to skip escaping dynamic user text — that is exactly what `html`` is for.
export function unsafeHtml(alreadySafe: string): SafeHtml {
  return new SafeHtml(alreadySafe);
}
