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
  // #837, arming two more. Both were chosen by MEASURING which surfaces their pages could already
  // answer for — arming one whose page needs rewriting would make this check the thing that demands
  // the rewrite, and a check that reddens a page nobody has had a chance to fix is the check that
  // gets deleted (ADR-239's staged-arming ruling).
  'admin-surface:embeds': {
    ns: 'adminEmbeds',
    // `remove` is an action of this screen and is listed on purpose even though neither page
    // describes removing a host: the page then has to say so in its own frontmatter
    // (`remove:none:<why>`), which puts the gap where a reader of the page can see it. Leaving the
    // key out of this table would hide the same gap in a file nobody opens.
    keys: ['add', 'host', 'remove'],
  },
  'admin-surface:spaces': {
    ns: 'adminSpaces',
    // One action, and the measurement that made it worth arming: the English page said "see who
    // manages what" while the button says "Manage". The check compares WORDS, not substrings, so
    // `manages` is not `Manage` — a reader hunting the button on the screen finds prose about
    // managing and no button. That is the drift this surface is armed for.
    keys: ['manage'],
  },
}
