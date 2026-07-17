// #447 / ADR-172 (#426 first slice): the MCP syntax-reference MANIFEST — the per-macro documentation
// the server's `get_syntax_reference` tool composes its reference from. One entry documents one or
// more REGISTRY NAMES (`names` is a covering set: the five callout types are one entry). The web-side
// lock-step test (mcp-manifest-lockstep.test.ts) requires the union of all `names` to equal the
// registered fence+directive name set EXACTLY — a macro added without a manifest entry fails the
// build, the same structural no-omission guarantee `exportFidelity` gives. Pure data, DOM-free
// (macro-render's package constraint). Curated prose that documents the FORMAT rather than a macro
// (the CommonMark preamble, frontmatter tags, inline marks) stays hand-written in mcp.ts.
export interface McpSyntaxEntry {
  /** The registry names (fence langs / directive names) this entry documents. */
  names: string[];
  /** Grouping heading in the generated reference ("Callouts (admonitions)", "Diagrams (fenced code)", …). */
  section: string;
  /** The syntax documentation itself, verbatim markdown (a fenced example block or a bullet line). */
  syntax: string;
  /** Optional one-liner constraints appended after the syntax block. */
  notes?: string;
}

export const MCP_SYNTAX_MANIFEST: readonly McpSyntaxEntry[] = [
  {
    names: ["note", "info", "tip", "warning", "danger"],
    section: "Callouts (admonitions)",
    syntax: "```\n:::note\nBody markdown.\n:::\n```",
    notes: "Types: `note`, `info`, `tip`, `warning`, `danger`.",
  },
  {
    names: ["details"],
    section: "Collapsible & layout",
    syntax: "- Details/disclosure: `:::details[Summary]` … `:::`",
  },
  {
    names: ["columns"],
    section: "Collapsible & layout",
    syntax: "- Columns: `:::columns` with inner `:::column` items … `:::`",
  },
  {
    names: ["tabs"],
    section: "Collapsible & layout",
    syntax: "- Tabs: `:::tabs` with inner `:::tab[Label]` items … `:::`",
  },
  {
    names: ["todo"],
    section: "Task list with a progress ring",
    syntax: "```\n:::todo[My tasks]\n- [ ] a task\n- [x] done\n:::\n```",
    notes: "(Plain GFM `- [ ]` task lists also work without the wrapper.)",
  },
  {
    names: ["mermaid"],
    section: "Diagrams (fenced code)",
    syntax: "- Mermaid: ```mermaid``` … flowchart/sequence/etc. … closing fence.",
  },
  {
    names: ["plantuml"],
    section: "Diagrams (fenced code)",
    syntax: "- PlantUML: ```plantuml``` … `@startuml` … `@enduml` … closing fence.",
  },
  {
    names: ["excalidraw"],
    section: "Diagrams (fenced code)",
    syntax: "- Excalidraw: ```excalidraw``` (drawn in the editor).",
  },
  {
    names: ["tagged"],
    section: "Dynamic lists (read-only)",
    syntax: "- Pages carrying a tag: `:::tagged` … `<tag name>` … `:::`",
  },
  {
    names: ["children"],
    section: "Dynamic lists (read-only)",
    syntax: "- This page's child pages: `:::children` … `:::` (empty body)",
    notes:
      "Both render auto-updating, read-only lists. (`:::query` and `:::backlinks` no longer exist; backlinks\nlive in the Related side panel.)",
  },
  {
    names: ["embed-page"],
    section: "Embeds & transclusion",
    syntax: "- Embed another page's content: `:::embed-page` … `<pageId>` … `:::`",
  },
  {
    names: ["embed-external"],
    section: "Embeds & transclusion",
    syntax: "- Embed an allowlisted external URL: `:::embed-external` … `<url>` … `:::`",
  },
  {
    names: ["table"],
    section: "Tables (rich)",
    syntax: "Standard GFM tables work. For HTML-bodied tables: `:::table` … HTML … `:::`.",
  },
];

// Compose the macro portion of the syntax reference: sections in first-appearance order, entries in
// manifest order within a section — deterministic (MCP clients may cache/diff the document).
export function renderMcpSyntaxSections(): string {
  const sections = new Map<string, string[]>();
  for (const e of MCP_SYNTAX_MANIFEST) {
    const blocks = sections.get(e.section) ?? [];
    blocks.push(e.notes ? `${e.syntax}\n${e.notes}` : e.syntax);
    sections.set(e.section, blocks);
  }
  return [...sections].map(([title, blocks]) => `## ${title}\n${blocks.join("\n")}`).join("\n\n");
}
