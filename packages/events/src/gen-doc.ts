// Generator for the "code is truth" domain-events reference (#139 / ADR-080 doc↔code
// linkage). Renders deterministic Markdown from EVENT_CATALOG (CE bus). A CI stale-guard
// (pnpm docs:check) regenerates this and fails if the committed Markdown drifts.

import { EVENT_CATALOG } from './catalog.js'

const HEADER = `<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Source: packages/events/src/catalog.ts (EVENT_CATALOG).
  Regenerate: pnpm docs:gen   ·   Verify (CI): pnpm docs:check
  This is the "code is truth" domain-event reference (the EE webhook / audit surface).
-->`

export function renderEventsMarkdown(): string {
  const lines: string[] = []
  // #748: "domain event" is a design term. The reader is here because they are wiring a webhook.
  lines.push(HEADER, '', '# Webhook events', '')
  lines.push(
    'The CE event bus emits a `DomainEvent` after each successful operation. EE features',
    '(webhooks, audit log, compliance export) subscribe to these. Events carry only ids,',
    'actors, and timestamps — never page content or secrets. Generated from the code',
    '(`EVENT_CATALOG`).',
    '',
  )
  lines.push('| Event | Description |')
  lines.push('|---|---|')
  for (const key of Object.keys(EVENT_CATALOG)) {
    const desc = EVENT_CATALOG[key as keyof typeof EVENT_CATALOG].replace(/\|/g, '\\|')
    lines.push(`| \`${key}\` | ${desc} |`)
  }
  lines.push('')
  return lines.join('\n')
}
