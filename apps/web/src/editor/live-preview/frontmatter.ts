import { WidgetType, type EditorView } from "@codemirror/view";
import i18n from "../../i18n";
import { tagSuggestSource } from "./decorations";

// #413 the suggest trigger glyph — Lucide "chevron-down" as a trusted inline constant (the same
// pattern as the code-fence copy button): identical across browsers/fonts, unlike the UA datalist ▼.
const FM_SUGGEST_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';


// #370 / ADR-145 §2: the document frontmatter subsystem — the leading `---\n…\n---` YAML fence of the SAME
// single Y.Text (no second CRDT, no metadata store). The block renders as a compact top-of-page "properties"
// widget (a tag-chip row); the caret inside reveals the raw YAML (the always-works editing fallback), and on
// an editable surface the widget itself carries a NARROW tag editor (add / remove chips) whose every change
// is ONE offset-invariant Y.Text edit rewriting the `tags:` line (ADR-025 discipline — the widget never
// touches Yjs; it dispatches through the view like the task-checkbox flips). v1 renders ONLY tags; any other
// frontmatter fields are preserved verbatim in the text (Open formats) but not shown.

export interface FrontmatterRange { from: number; to: number; inner: string }

// The leading frontmatter block: position-0-only (like every SSG), closed by a `---` / `...` line.
// An unterminated fence is NOT frontmatter (a lone `---` is a thematic break).
export function parseFrontmatterRange(doc: string): FrontmatterRange | null {
  if (!/^---[ \t]*(\r?\n|$)/.test(doc)) return null;
  const lines = doc.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*\r?$/.test(lines[i]!)) {
      return { from: 0, to: lines.slice(0, i + 1).join("\n").length, inner: lines.slice(1, i).join("\n") };
    }
  }
  return null;
}

export interface FmTag { tag: string; display: string }
const TAG_MAX_LEN = 100;

function cleanTag(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  return s.slice(0, TAG_MAX_LEN);
}

// Minimal YAML-subset `tags:` extraction (inline array / dash list / single scalar) — mirrors the server's
// extractFrontmatterTags (pages.ts) so the widget shows exactly what publish will index. Case-insensitive
// identity: `tag` is the lowercased key, `display` the first-seen casing.
export function parseFmTags(inner: string): FmTag[] {
  const lines = inner.split("\n");
  const raw: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^tags[ \t]*:[ \t]*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const rest = m[1]!.trim();
    if (rest.startsWith("[")) {
      const body = rest.endsWith("]") ? rest.slice(1, -1) : rest.slice(1);
      raw.push(...body.split(","));
    } else if (rest === "") {
      for (let j = i + 1; j < lines.length; j++) {
        const dm = /^[ \t]*-[ \t]+(.*)$/.exec(lines[j]!);
        if (!dm) break;
        raw.push(dm[1]!);
      }
    } else {
      raw.push(rest);
    }
    break;
  }
  const out: FmTag[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const display = cleanTag(r);
    if (!display) continue;
    const tag = display.toLowerCase();
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, display });
  }
  return out;
}

// Quote a tag for the inline-array form when it needs it (comma / bracket / quote / leading-trailing space).
function yamlTag(display: string): string {
  return /[,\[\]"']/.test(display) || display !== display.trim() ? `"${display.replace(/"/g, '\\"')}"` : display;
}

// Rewrite the frontmatter BLOCK text with the given tags as ONE inline `tags: [...]` line: an existing
// `tags:` entry (any of the three forms) is replaced in place; a missing one is inserted after the opening
// fence; an empty tag list REMOVES the line. All other frontmatter lines are preserved verbatim.
export function setTagsInFrontmatter(block: string, tags: readonly string[]): string {
  const lines = block.split("\n");
  const tagsLine = tags.length > 0 ? `tags: [${tags.map(yamlTag).join(", ")}]` : null;
  // find the existing tags entry (line i .. j-1, dash-list continuation included)
  for (let i = 1; i < lines.length - 1; i++) {
    const m = /^tags[ \t]*:[ \t]*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    if (m[1]!.trim() === "") {
      while (j < lines.length - 1 && /^[ \t]*-[ \t]+/.test(lines[j]!)) j++;
    }
    const replaced = [...lines.slice(0, i), ...(tagsLine ? [tagsLine] : []), ...lines.slice(j)];
    return replaced.join("\n");
  }
  if (!tagsLine) return block;
  return [lines[0]!, tagsLine, ...lines.slice(1)].join("\n");
}

// The top-of-page properties widget: a "Tags" label + chips; editable surfaces add per-chip remove (×) and
// an add-tag input. Block-widget discipline (the project design notes): padding not margin; stable eq() key (the block
// source + editability); interactive children stopPropagation on mousedown (NOT ignoreEvent=true — that
// would swallow keydown and break Escape). Every mutation is one view.dispatch replacing the whole block
// (offset-invariant: the change maps through collab like any typed edit).
export class FrontmatterWidget extends WidgetType {
  constructor(readonly src: string, readonly canEdit: boolean, readonly selected: boolean) { super(); }
  eq(o: FrontmatterWidget) { return o.src === this.src && o.canEdit === this.canEdit && o.selected === this.selected; }

  private write(view: EditorView, tags: string[]) {
    const range = parseFrontmatterRange(view.state.doc.toString());
    if (!range) return; // the block vanished under us (remote edit) — do nothing
    view.dispatch({ changes: { from: range.from, to: range.to, insert: setTagsInFrontmatter(view.state.doc.sliceString(range.from, range.to), tags) } });
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-frontmatter";
    wrap.setAttribute("data-testid", "frontmatter-widget");
    // #438 the SHARED ring class (cm-lp-atom-sel) — the widget shipped with its own
    // "cm-lp-atom-selected", which no CSS rule matches, so a selected frontmatter atom never ringed.
    if (this.selected) wrap.classList.add("cm-lp-atom-sel");
    wrap.contentEditable = "false";
    const range = parseFrontmatterRange(this.src);
    const tags = range ? parseFmTags(range.inner) : [];
    const label = document.createElement("span");
    label.className = "cm-lp-frontmatter-label";
    label.textContent = i18n.t("frontmatter.tagsLabel");
    wrap.appendChild(label);
    for (const t of tags) {
      const chip = document.createElement("span");
      chip.className = "cm-lp-frontmatter-chip";
      chip.setAttribute("data-testid", `fm-tag-${t.tag}`);
      const txt = document.createElement("span");
      txt.textContent = t.display;
      chip.appendChild(txt);
      if (this.canEdit) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "cm-lp-frontmatter-remove";
        rm.setAttribute("data-testid", `fm-tag-remove-${t.tag}`);
        rm.setAttribute("aria-label", `remove ${t.display}`);
        rm.textContent = "×";
        // interactive DOM inside an atom: stopPropagation on mousedown so CM neither moves the caret nor
        // treats it as an atom click (the #265 lesson); keydown still bubbles (Escape works).
        rm.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        rm.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          this.write(view, tags.filter((x) => x.tag !== t.tag).map((x) => x.display));
        });
        chip.appendChild(rm);
      }
      wrap.appendChild(chip);
    }
    if (!this.canEdit && tags.length === 0) {
      const empty = document.createElement("span");
      empty.className = "cm-lp-frontmatter-empty";
      empty.textContent = i18n.t("frontmatter.empty");
      wrap.appendChild(empty);
    }
    if (this.canEdit) {
      const input = document.createElement("input");
      input.className = "cm-lp-frontmatter-input";
      input.setAttribute("data-testid", "fm-tag-input");
      input.placeholder = i18n.t("frontmatter.addTag");
      // #413 CUSTOM autocomplete (the native <datalist> is retired — its dropdown only filled on
      // `input`, opened on browser-controlled timing, and drew a UA-dependent ▼). The popup is app-owned
      // persistent DOM INSIDE the widget (block-widget rule: the tooltip layer is for floating editor UI,
      // but this rides the input row and dies with the widget rebuild — which closes it, correct), fed by
      // the host's view-filtered suggest seam (absent on guest/template surfaces → plain input, authz
      // unchanged). Trigger = a Lucide chevron (inline trusted SVG — consistent across browsers/fonts);
      // focus/click fetch and OPEN immediately (empty query = the full view-filtered list), typing
      // narrows, ↑↓/Enter/Esc navigate. Styled via the .cm-lp-fm-suggest* baseTheme rules (DS tokens).
      const suggest = view.state.facet(tagSuggestSource);
      const inputRow = document.createElement("span");
      inputRow.className = "cm-lp-fm-inputrow";
      inputRow.appendChild(input);
      const addTag = (raw: string) => {
        const v = cleanTag(raw);
        if (v && !tags.some((t) => t.tag === v.toLowerCase())) {
          this.write(view, [...tags.map((t) => t.display), v]);
        }
        input.value = "";
      };
      let suggestKeys: ((e: KeyboardEvent) => boolean) | null = null;
      if (suggest) {
        const box = document.createElement("div");
        box.className = "cm-lp-fm-suggest";
        box.setAttribute("data-testid", "fm-tag-suggest");
        box.style.display = "none";
        let items: string[] = [];
        let active = -1;
        let openState = false;
        let seq = 0;
        let debounce: ReturnType<typeof setTimeout> | null = null;
        const render = () => {
          box.replaceChildren();
          if (!openState || items.length === 0) { box.style.display = "none"; return; }
          box.style.display = "";
          items.forEach((d, i) => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = i === active ? "cm-lp-fm-suggest-item cm-lp-fm-suggest-active" : "cm-lp-fm-suggest-item";
            row.setAttribute("data-testid", "fm-tag-suggest-item");
            row.textContent = d; // author text — textContent only
            row.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }); // #265 guard
            row.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); addTag(d); });
            box.appendChild(row);
          });
        };
        const close = () => { openState = false; active = -1; render(); };
        const fetchAndOpen = (q: string) => {
          const my = ++seq;
          void suggest(q).then((res) => {
            if (my !== seq || res == null) return;
            const have = new Set(tags.map((t) => t.tag));
            items = res.map((r) => r.display).filter((d) => !have.has(d.toLowerCase()));
            active = items.length ? 0 : -1;
            openState = true;
            render();
          });
        };
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "cm-lp-fm-suggest-trigger";
        trigger.setAttribute("data-testid", "fm-tag-suggest-open");
        trigger.setAttribute("aria-label", i18n.t("frontmatter.suggestOpen"));
        trigger.innerHTML = FM_SUGGEST_ICON; // trusted constant (no user input)
        trigger.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }); // #265 guard
        trigger.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          if (openState) { close(); return; }
          input.focus();
          fetchAndOpen(input.value.trim());
        });
        input.addEventListener("focus", () => fetchAndOpen(input.value.trim()));
        input.addEventListener("input", () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => fetchAndOpen(input.value.trim()), 120);
        });
        // let an item click land before closing (mousedown is prevented, click fires before this timer)
        input.addEventListener("blur", () => { setTimeout(close, 150); });
        suggestKeys = (e: KeyboardEvent) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (!openState) { fetchAndOpen(input.value.trim()); return true; }
            if (items.length) {
              active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
              render();
            }
            return true;
          }
          if (e.key === "Enter" && openState && active >= 0 && items[active]) {
            addTag(items[active]!);
            close();
            return true;
          }
          if (e.key === "Escape" && openState) {
            close();
            return true; // first Esc closes the popup; a second one blurs (below)
          }
          return false;
        };
        inputRow.appendChild(trigger);
        inputRow.appendChild(box);
      }
      input.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // typing in the input must never reach CM keymaps (incl. vim)
        if (suggestKeys && suggestKeys(e)) { e.preventDefault(); return; }
        if (e.key === "Enter") {
          addTag(input.value);
          e.preventDefault();
        } else if (e.key === "Escape") {
          input.blur();
          view.focus();
          e.preventDefault();
        }
      });
      wrap.appendChild(inputRow);
    }
    return wrap;
  }

  ignoreEvent(e: Event) {
    // let CM handle plain clicks on the widget body (atom selection), but keep events that originate in the
    // interactive children (input / remove buttons) inside the widget.
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "BUTTON");
  }
}
