import { Input } from "./Input";

// #416 / ADR-161: the shared member-typeahead input — one implementation for every "pick a member"
// surface (space members tab, the page permissions dialog's grant + restrict inputs). Presentation
// only: the CALLER owns the query state, fetches candidates through its own view-gated endpoint
// (space- or page-scoped — the server gate is the authority), and decides what a pick means. Raw
// input stays allowed everywhere (a sub can be typed/pasted verbatim — the picker assists, it never
// gates), so pre-picker flows keep working.
export interface MemberCandidate {
  sub: string;
  displayName: string | null;
}

export function MemberSearchInput(props: {
  query: string;
  onQueryChange: (q: string) => void;
  picked: { grantee: string; label: string } | null;
  onPick: (c: MemberCandidate | null) => void;
  candidates: MemberCandidate[];
  placeholder: string;
  ariaLabel: string;
  inputTestId: string;
  listTestId: string;
  itemTestId: string;
  inputSize?: "sm" | undefined;
}) {
  const { query, onQueryChange, picked, onPick, candidates } = props;
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        className="w-full"
        inputSize={props.inputSize}
        data-testid={props.inputTestId}
        value={picked ? picked.label : query}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        onChange={(e) => { onPick(null); onQueryChange(e.target.value); }}
      />
      {!picked && query.trim().length > 0 && candidates.length > 0 && (
        <ul className="absolute left-0 right-0 top-[calc(100%+2px)] z-20 m-0 max-h-60 list-none overflow-y-auto rounded-md border border-border bg-panel p-1 shadow-md" data-testid={props.listTestId}>
          {candidates.map((c) => (
            <li key={c.sub}>
              <button
                type="button"
                className="flex w-full cursor-pointer flex-col gap-px rounded-sm border-none bg-transparent px-2 py-1.5 text-left text-foreground hover:bg-panel-2"
                data-testid={props.itemTestId}
                onClick={() => onPick(c)}
              >
                {/* #532: the row shows the NAME. The sub used to sit under it as a second line, from when
                    it was the only identifier a member could see — #523 canonicalised display names from
                    the IdP, so the opaque id is now just noise in a picker. It is still what gets SENT
                    (`user:<sub>`), and still the fallback text for a member who has no name yet. */}
                <span className="text-sm">{c.displayName || c.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
