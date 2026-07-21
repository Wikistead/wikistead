// A relative timestamp ("3 minutes ago") plus the absolute time for the hover title.
// Locale-aware via Intl.RelativeTimeFormat (the i18n language); `abs` is the full
// toLocaleString. Extracted from CommentsPanel/PageMeta, which carried identical copies,
// when the API-key list needed a third (#461).
export function relTime(iso: string, lang: string): { rel: string; abs: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { rel: iso, abs: iso };
  const abs = d.toLocaleString();
  const secs = Math.round((d.getTime() - Date.now()) / 1000); // negative = past
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const table: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  for (const [unit, s] of table) {
    if (Math.abs(secs) >= s) return { rel: rtf.format(Math.round(secs / s), unit), abs };
  }
  return { rel: rtf.format(secs, "second"), abs };
}
