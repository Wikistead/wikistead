import { useEffect, useState } from "react";

// Debounce a fast-changing value (e.g. a search input) so we query the API at
// most once per `delay` of quiet — not on every keystroke.
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
