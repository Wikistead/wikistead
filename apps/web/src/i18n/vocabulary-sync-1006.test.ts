// #1006 / ADR-260 §3.3 / §6.4: the six event-type labels the digest mail will read (ADR-260 §7 item 4,
// #1008) are the SAME words this screen already shows under `eventTypes.<type>` — copied into
// @wikistead/i18n-shared rather than re-translated (see that package's own comment for why a literal
// JSON copy still exists there: no-orphan-keys-645's own self-test reads `eventTypes.page.published`
// out of the raw locale file, so removing it from the JSON would break the pin that protects it).
//
// A copy nobody checks is exactly the drift ADR-260 exists to stop — for the label text this time,
// not the screen's own translation. This pin is that check: it reads BOTH sides and fails the moment
// they say something different, so a future edit to either has to touch both on purpose.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVENT_TYPE_LABELS, LANGS, type FeedEventType } from "@wikistead/i18n-shared";

const LOCALES = resolve(import.meta.dirname, "locales");
const read = (lang: string) => JSON.parse(readFileSync(resolve(LOCALES, `${lang}.json`), "utf8")) as Record<string, unknown>;

// Same shape as apps/web's own t(`eventTypes.${type}`) call (WatchListPage.tsx, AccountPage.tsx):
// dot-path resolution against the nested locale JSON.
function atPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), obj);
}

const EVENT_TYPES = Object.keys(EVENT_TYPE_LABELS.en) as FeedEventType[];

describe("#1006: the shared event-type labels say the SAME thing as the screen", () => {
  it("covers exactly the six event types the digest writes", () => {
    expect(EVENT_TYPES.sort()).toEqual([
      "attachment.confirmed", "comment.created", "page.made_non_public", "page.made_public", "page.published", "page.restored",
    ]);
  });

  it.each(LANGS)("%s: every label matches the locale JSON, word for word", (lang) => {
    const json = read(lang);
    for (const type of EVENT_TYPES) {
      const fromJson = atPath(json, `eventTypes.${type}`);
      expect(fromJson, `eventTypes.${type} exists in ${lang}.json`).toBeTypeOf("string");
      expect(EVENT_TYPE_LABELS[lang][type], `${lang}/${type}: shared label vs. the screen's own words`).toBe(fromJson);
    }
  });
});
