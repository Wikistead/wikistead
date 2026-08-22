// Generator for the "code is truth" domain-events reference (#139 / ADR-080 doc↔code
// linkage). Renders deterministic Markdown from EVENT_CATALOG (CE bus). A CI stale-guard
// (pnpm docs:check) regenerates this and fails if the committed Markdown drifts.

import { EVENT_CATALOG } from './catalog.js'

const HEADER = `<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Source: packages/events/src/catalog.ts (EVENT_CATALOG) + apps/server/src/webhooks/egress.ts.
  Regenerate: pnpm docs:gen   ·   Verify (CI): pnpm docs:check
  This is the "code is truth" domain-event reference (the EE webhook / audit surface).
-->`

/**
 * What each event may send outside the tenant, as the server decides it.
 *
 * ⚠️ Passed in rather than imported: the decision is the server's (`webhooks/egress.ts`), and this
 * package sits below it. It is passed at all because the page used to say webhooks were built on the
 * whole catalogue, which stopped being true when five types were ruled out of egress (#862) — a
 * reference that lists an event a reader can never receive sends them looking for a bug in their own
 * integration.
 */
export type EgressSummary = Record<string, { kind: 'send' | 'drop' | 'redact'; withheld?: readonly string[] }>

export function renderEventsMarkdown(egress: EgressSummary = {}): string {
  const lines: string[] = []
  // #748: "domain event" is a design term. The reader is here because they are wiring a webhook.
  lines.push(HEADER, '', '# Webhook events', '')
  // #817 (follows #814): the intro speaks the reader's language too — no code identifiers in the
  // prose. No generated-ness sentence here either: the docs-site pull stamps a provenance note on
  // every generated page already, and saying it twice reads as a tic (#814).
  lines.push(
    'Every successful operation emits one of the events below. Webhooks, the audit',
    'log and compliance export are all built on them. An event carries ids, who did',
    'it and when — never page content, and never a secret.',
    '',
    'A few events stay inside your workspace and are never sent to a webhook. Sign-in',
    'attempts are one per request, so delivering them would be a firehose rather than a',
    'signal; recovery actions by our staff are reported to you without naming the person',
    'who performed them. The last column says what each event sends.',
    '',
  )
  lines.push('| Event | Description | Sent to webhooks |')
  lines.push('|---|---|---|')
  for (const key of Object.keys(EVENT_CATALOG)) {
    const desc = EVENT_CATALOG[key as keyof typeof EVENT_CATALOG].replace(/\|/g, '\\|')
    const v = egress[key]
    const sent =
      v?.kind === 'drop' ? 'No'
      : v?.kind === 'redact' && v.withheld?.length ? `Yes, without ${v.withheld.map((f) => `\`${f}\``).join(', ')}`
      : 'Yes'
    lines.push(`| \`${key}\` | ${desc} | ${sent} |`)
  }
  lines.push('')
  return lines.join('\n')
}
