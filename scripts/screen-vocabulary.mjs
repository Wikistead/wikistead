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
  // #1063, continuing #1061's staged arming (10 surfaces remained with no owner). Public was chosen
  // for the same reason branding was: its whole vocabulary is one control, and the page already named
  // the section (**Admin → Public access**) without naming the toggle itself — a one-phrase addition,
  // not a rewrite. `onHint`/`offHint` are excluded from this arming on purpose: they are the hint text
  // under the switch, the "toasts and hints" category #741's own header names as out of scope, not an
  // action or a state a reader hunts a button or badge for.
  'admin-surface:public': {
    ns: 'adminPublic',
    keys: ['toggleTitle'],
  },
  // #1063, second surface of this slice. Moderation was chosen because measuring it (not just
  // reading it) found the drift #741's whole mechanism exists to catch: the English page said
  // "Mass-delete detection" for the button labelled "Mass-delete guard", and the Japanese page said
  // (detection) and (banned word) for a screen that says
  // (guard) and — both pages fixed in the same change, not just armed against what they
  // already said. `off` is left OUT of this vocabulary (not armed-then-excused): it names the
  // placeholder shown inside an empty input, not a label or state a reader hunts for on the screen
  // — the same judgement call `onHint`/`offHint` got on the public surface, for being hint prose
  // rather than an action or a state.
  'admin-surface:moderation': {
    ns: 'adminModeration',
    keys: ['shrinkLabel', 'wordsLabel'],
  },
  // #1063, third surface of this slice. The locale namespace here is `billing`, not
  // `adminBilling` like the other admin surfaces — this tab predates the `admin*` naming
  // convention and was never renamed (checked: `AdminBillingTab.tsx` reads `billing.*` throughout).
  // Two buttons, mutually exclusive by plan state (free vs. already-billed), both worth arming.
  'admin-surface:billing': {
    ns: 'billing',
    keys: ['upgradePro', 'manage'],
  },
  // #1063, fourth surface of this slice. `resetFactors`'s ja value already matched the ja page
  // exactly ("2 ") — only the en page had drifted, naming "reset a member's
  // second factors" for a button labelled "Reset two-factor authentication". `suspend` and
  // `sendInvite` were both discussed in prose on both pages but never set off as the button label
  // itself; `reactivate` ("Bring back" / ) already matched on both pages untouched.
  'admin-surface:members': {
    ns: 'members',
    keys: ['suspend', 'reactivate', 'resetFactors', 'sendInvite'],
  },
  // #1063, fifth surface of this slice. The ledger's `admin-surface:scim` entry (doc-code-map.mjs)
  // points at `admin/scim.md`, which does not exist — the real page is `admin/scim-provisioning.md`
  // (#759 already flagged this dangling ledger path as its own open point, not fixed here).
  // Two token-lifecycle buttons; the rest of the page's vocabulary (endpoint, tokenName) is form-field
  // prose rather than an action or a state a reader hunts for on the screen.
  'admin-surface:scim': {
    ns: 'adminScim',
    keys: ['create', 'revoke'],
  },
  // #1063, sixth surface of this slice. Both pages already named the mechanism ("hash chain" /
  // ) but not the two console actions that act on it.
  'admin-surface:audit': {
    ns: 'adminAudit',
    keys: ['verify', 'export'],
  },
  // #1063, seventh surface of this slice. `AdminAnalyticsTab.tsx` only owns `tenantAnalytics.title`/
  // `.hint` (2 keys, no actions) — the actual controls (the viewer-class filter, the unique-viewers
  // toggle) live in the shared `AnalyticsDashboard` component both the tenant and per-space tabs
  // render, under the `spaceAnalytics` namespace it was built for first (checked: same two calls,
  // `apps/web/src/settings/AnalyticsDashboard.tsx:71-87`, run for both tabs).
  'admin-surface:analytics': {
    ns: 'spaceAnalytics',
    keys: ['viewerClass', 'unique'],
  },
  // #1063, eighth surface of this slice. The namespace has 30+ keys (the resource/scope grant matrix
  // alone is 18) — staying with the discipline of arming the few ACTIONS a reader hunts a button for,
  // not the whole form. Both pages already discussed create/revoke conceptually without naming the
  // buttons themselves.
  'admin-surface:api': {
    ns: 'adminApi',
    keys: ['create', 'revoke'],
  },
  // #1063, ninth surface of this slice. This namespace is the largest by far (70+ keys: OIDC config,
  // SAML config, second-factor stance, SSO-required, exemptions...) and the page covers only a
  // subset of it (doors + second-factor stance; SAML, SSO-required and the OIDC test-connection
  // button are real gaps, not arming candidates today — forcing them in would be new content, not
  // the "page already answers" bar this staged arming holds to). One key: the page's own "Turning
  // the requirement on" already named the concept without the actual toggle label.
  'admin-surface:auth': {
    ns: 'adminAuth',
    keys: ['secondFactorRequired'],
  },
  // #1063, tenth and final surface of this slice — closes the surface #1061 declared armable. Unlike
  // the others, the page genuinely had no coverage of the operation this surface exists for (#1061's
  // "). A "Rescuing a draft" section was added rather than a one-phrase patch, describing the real
  // two-step flow (claim grants temporary read access; reassign hands the draft to its new owner and
  // ends that access) as the product actually implements it (`AdminOrphanDraftsTab.tsx`,
  // `routes/orphan-drafts.ts`).
  'admin-surface:orphans': {
    ns: 'adminOrphans',
    keys: ['claim', 'reassign'],
  },
}
