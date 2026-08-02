// #588: what a key does to the @mention list, as a value.
//
// The list had no keyboard handling at all, so the only way to take a suggestion was the mouse. The
// convention is the app's own and is not re-invented here: Ctrl-j / Ctrl-k plus the arrows (Ctrl-n and
// Ctrl-p are browser-reserved, which is why the palette chose j/k in the first place), Enter confirms,
// Escape closes.
//
// It lives in its own module because the interesting half — where the highlight lands, and which keys
// the composer must NOT swallow — is arithmetic and policy, and the e2e tenant seats exactly one
// page-viewer, so a browser cannot demonstrate moving between rows there. The browser test covers what
// only a browser can (the keys reach the textarea, Enter inserts, Escape closes, and a closed list
// leaves Enter to the composer); this covers the rest.

export type MentionKey =
  | { action: "move"; delta: 1 | -1 }
  | { action: "confirm" }
  | { action: "close" }
  | { action: "pass" }; // not ours — the composer keeps its own behaviour

/** Classify a keypress while the suggestion list is OPEN. A closed list is never asked. */
export function classifyMentionKey(e: { key: string; ctrlKey: boolean; shiftKey: boolean }): MentionKey {
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) return { action: "move", delta: 1 };
  if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) return { action: "move", delta: -1 };
  // Shift+Enter stays a newline: the list is a suggestion, not a modal, and taking every Enter would
  // make a multi-line comment impossible to write while a mention is being typed.
  if (e.key === "Enter" && !e.shiftKey) return { action: "confirm" };
  if (e.key === "Escape") return { action: "close" };
  // Tab is deliberately NOT a confirm. It keeps moving focus to the submit button, which is the only
  // keyboard route out of the composer; taking it would close that route to gain a second way of
  // doing what Enter already does.
  return { action: "pass" };
}

/** The next highlighted row, wrapping at both ends (a list of one stays where it is). */
export function nextMentionIndex(current: number, length: number, delta: 1 | -1): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

// #594 (user ruling): the composer takes the chat convention — Enter posts, Shift-Enter breaks the
// line. Two industry conventions exist and this product picked the chat one; the other (Enter breaks,
// Ctrl-Enter posts) is what GitHub and Jira do.
//
// The decision is a value for the same reason the mention keys are: the interesting part is IME.
// Confirming a Japanese conversion candidate is an Enter keydown, and posting on it would make the
// composer unusable in Japanese — the comment goes out mid-word, every time. A browser cannot be made
// to run a real IME in a test, so the rule lives here where a synthetic event with `isComposing` set
// proves it, and the browser test covers what only a browser can.
export type ComposerKey = { action: "submit" } | { action: "newline" };

export function classifyComposerKey(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): ComposerKey {
  if (e.key !== "Enter") return { action: "newline" };
  // The conversion-confirming Enter. `keyCode === 229` is the older browsers' way of saying the same
  // thing and costs nothing to keep — this is the one branch whose absence breaks a whole language.
  if (e.isComposing === true || e.keyCode === 229) return { action: "newline" };
  if (e.shiftKey) return { action: "newline" };
  // Ctrl-Enter / Cmd-Enter also post: Slack accepts both, and a Mac user's fingers arrive with Cmd
  // held. Nothing is lost by accepting the modifier that means the same thing.
  return { action: "submit" };
}
