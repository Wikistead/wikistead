import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Combobox, createListCollection } from "@ark-ui/react/combobox";
import { Portal } from "@ark-ui/react/portal";
import { Search } from "lucide-react";
import { useSearch, useSpaces } from "../data/queries";
import { useDebouncedValue } from "./useDebouncedValue";
import styles from "./SearchBox.module.css";

interface Item {
  value: string; // page id
  label: string; // title
  space: string; // space name (breadcrumb)
  snippet: string; // cropped plain-text body excerpt (may be empty)
}

// Tenant page search. The two-stage guard (Meili + FGA) lives entirely in the
// API; this component only renders the authorized hits it returns. The body
// snippet is plain text (the API strips markup) and rendered AS TEXT — never via
// dangerouslySetInnerHTML — so user-authored content cannot inject markup, and a
// snippet only ever appears for a page the user is allowed to view. Cmd/Ctrl-K
// focuses the input. Not rendered on guest routes.
export function SearchBox() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const debounced = useDebouncedValue(input, 250);
  const { data: hits, isFetching } = useSearch(debounced);
  const spaces = useSpaces();
  const inputRef = useRef<HTMLInputElement>(null);

  const spaceName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of spaces.data ?? []) m.set(s.id, s.name || "Untitled space");
    return m;
  }, [spaces.data]);

  const collection = useMemo(
    () =>
      createListCollection<Item>({
        items: (hits ?? []).map((h) => ({
          value: h.id,
          label: h.title || "Untitled",
          space: spaceName.get(h.spaceId) ?? "",
          snippet: h.snippet ?? "",
        })),
        itemToValue: (i) => i.value,
        itemToString: (i) => i.label,
      }),
    [hits, spaceName],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Combobox.Root
      collection={collection}
      inputValue={input}
      onInputValueChange={(d) => setInput(d.inputValue)}
      onValueChange={(d) => {
        const id = d.value[0];
        if (id) {
          navigate(`/p/${id}`);
          setInput("");
        }
      }}
      openOnClick={false}
      selectionBehavior="clear"
      placeholder="Search pages…"
      className={styles.root}
    >
      <Combobox.Control className={styles.control}>
        <Search size={14} className={styles.icon} aria-hidden />
        <Combobox.Input ref={inputRef} className={styles.input} data-testid="search-input" placeholder="Search pages…  (Ctrl-K)" />
      </Combobox.Control>
      <Portal>
        <Combobox.Positioner>
          <Combobox.Content className={styles.content} data-testid="search-results">
            {debounced.trim().length === 0 ? null : isFetching && (hits?.length ?? 0) === 0 ? (
              <div className={styles.note}>Searching…</div>
            ) : (hits?.length ?? 0) === 0 ? (
              <Combobox.Empty className={styles.note}>No results</Combobox.Empty>
            ) : (
              collection.items.map((item) => (
                <Combobox.Item key={item.value} item={item} className={styles.item} data-testid="search-item">
                  <Combobox.ItemText className={styles.itemTitle}>{item.label}</Combobox.ItemText>
                  {item.space && <span className={styles.itemSpace}>{item.space}</span>}
                  {item.snippet && <span className={styles.itemSnippet} data-testid="search-snippet">{item.snippet}</span>}
                </Combobox.Item>
              ))
            )}
          </Combobox.Content>
        </Combobox.Positioner>
      </Portal>
    </Combobox.Root>
  );
}
