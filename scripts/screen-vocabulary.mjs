// #741 / ADR-239 (a): WHICH strings on a surface are the ones a reader looks for.
//
// The words themselves are NOT here. They are read out of the locale files when the artifact is
// generated, so a rename lands in the artifact and the check follows it — the indirection #731
// established after #732 renamed a pile of labels on the day that check landed, and a check with the
// words baked in would have gone red for being right.
//
// What IS here is the judgement a machine cannot make: which of a surface's forty strings are its
// ACTIONS and STATES — the button somebody must press, the badge that says what state a row is in
// as opposed to its body prose, its toasts and its hints. ADR-239 §(c) demands the product's word for
// each of these appear on the page that claims the surface, and demanding a paragraph of body text is
// how a check becomes noise. Keeping this list honest is review, not CI; ADR-239 says so out loud
// rather than pretending a regular expression over JSX could do it.
//
// ARMED SURFACE BY SURFACE (owner ruling 2026-08-19, #741 ②): a first run that reddened every
// admin page at once would be paid off by deleting the check. Domains is first because it is where
// the drift was measured — the page said for , for , and for .
export const SCREEN_VOCABULARY = {
  'admin-surface:domains': {
    /** the locale-file namespace these keys live under */
    ns: 'adminDomains',
    /** the ACTIONS and STATES of the screen; every one of these is demanded of a page that claims it */
    keys: ['verify', 'verified', 'pending', 'release'],
  },
}
