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
  // #981, continuing the staged arming (13 surfaces remained with no owner — measured by #981's own
  // audit that #837's follow-up ADR only DECLARES the rest, it does not arm them). `builtIn` is the
  // one state the roles page already describes in prose ("built-in and custom under one framework");
  // `create` / `rename` / `delete` are declared with a `:none:` reason in the docs page's own
  // frontmatter rather than forced into prose that would need a rewrite this ticket does not do
  // the staged-arming ruling (#741 ②) is about not reddening a page nobody has fixed, not about
  // arming only what needs no docs edit at all.
  'admin-surface:roles': {
    ns: 'adminRoles',
    keys: ['builtIn', 'create', 'rename', 'delete'],
  },
  // #1043, continuing #981's staged arming. `disabled` is the one state #981's own audit flagged as
  // armable with a light wording change (the page said "disable" the verb; the badge says "Disabled"
  // the state — the same drift `manage`/`manages` was armed for on the spaces surface). `create` /
  // `delete` are declared `:none:` in the docs page's own frontmatter: the page describes registering
  // an endpoint and never names the Add button, and never describes removing a webhook at all — both
  // gaps the `:none:` reason puts where a reader of the page can see them, same as roles above.
  'admin-surface:webhooks': {
    ns: 'adminWebhooks',
    keys: ['disabled', 'create', 'delete'],
  },
  // #1061, continuing #1043's staged arming (11 surfaces remained with no owner). Branding was chosen
  // because its whole vocabulary is two buttons and both were already answerable with a one-sentence
  // addition — the staged-arming ruling (#741 ②) is about not reddening a page nobody has fixed,
  // and a page needing one sentence is not that page. `logoRemove`'s English string is the bare word
  // "Remove" — armed anyway, since the check only demands the word appear set off correctly once, not
  // that it be unique to this surface.
  'admin-surface:branding': {
    ns: 'tenantBranding',
    keys: ['logoUpload', 'logoRemove'],
  },
}
