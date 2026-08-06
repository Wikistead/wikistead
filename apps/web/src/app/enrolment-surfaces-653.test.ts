import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// #653 the QR shipped on ONE of the two screens that can start an enrolment.
//
// The other screen — the one during sign-in — was already being handed the same `uri` field by the same
// server, and dropped it in a type. Nobody noticed for a release, because every test that knew about
// QR codes was pointed at the screen that had one.
//
// So this does not check "the settings panel and the interstitial both draw a QR". A list of two names
// is exactly the artefact that failed: it says nothing about the third surface, and there will be a
// third — the passkey work in this same ticket adds enrolment entry points, and #663's landing added
// more. Instead it DISCOVERS the surfaces, starting from the only place the fact is unambiguous — the
// server routes that mint an `otpauth://` URI — and then requires that every screen which can reach one
// offers both ways in: the code for a camera, the key for fingers.
//
// The sets must COINCIDE. A screen with only a QR strands a reader whose camera cannot see the screen;
// a screen with only a key is where this ticket started.
const ROOT = resolve(import.meta.dirname, "../../../..");
const SERVER_ROUTES = join(ROOT, "apps/server/src/routes");
const WEB_SRC = join(ROOT, "apps/web/src");

function walk(dir: string, keep: (f: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : walk(p, keep);
    return keep(p) ? [p] : [];
  });
}

const isSource = (p: string) =>
  /\.(ts|tsx)$/.test(p) && !/\.test\.|__tests__|\/tests\//.test(p);

/**
 * Every server route that hands a TOTP enrolment URI to a browser, found by the call that builds one.
 *
 * Walking BACKWARDS from `totpUri(` to the nearest route registration rather than listing paths: a new
 * enrolment endpoint is discovered by the thing that makes it an enrolment endpoint, not by somebody
 * remembering to add it here.
 */
function routesMintingAnEnrolmentUri(): { file: string; path: string }[] {
  const found: { file: string; path: string }[] = [];
  for (const file of walk(SERVER_ROUTES, isSource)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\btotpUri\s*\(/g)) {
      const before = src.slice(0, m.index);
      // the last route registration opened above this call — `app.post<...>('/path'` / `app.post('/path'`
      const regs = [...before.matchAll(/\bapp\.(?:post|get|put|patch)\s*(?:<[\s\S]*?>)?\s*\(\s*['"]([^'"]+)['"]/g)];
      const last = regs.at(-1);
      if (last && !found.some((f) => f.path === last[1])) found.push({ file, path: last[1] });
    }
  }
  return found;
}

/** Web source files, by path, with their text — read once. */
const WEB: { file: string; src: string }[] = walk(WEB_SRC, isSource)
  .map((file) => ({ file, src: readFileSync(file, "utf8") }));

const rel = (p: string) => p.slice(ROOT.length + 1);

/**
 * Which components put this endpoint on a screen.
 *
 * Two hops, because this codebase calls its API two ways: a component may `fetch` the path itself (the
 * sign-in screen has no session, so it does), or it may go through a hook in `queries.ts`. In the
 * second case the file holding the literal is a data module that renders nothing, so the surface is
 * whichever component imports that hook.
 */
function surfacesReaching(path: string): string[] {
  const holders = WEB.filter((f) => f.src.includes(`"${path}"`) || f.src.includes(`\`${path}`));
  const surfaces: string[] = [];
  for (const holder of holders) {
    if (/\.tsx$/.test(holder.file)) { surfaces.push(holder.file); continue; }
    // a data module: find the exported hooks whose body mentions the path, then who imports them
    for (const m of holder.src.matchAll(/export function (use[A-Za-z0-9_]+)\(([\s\S]*?)\n}/g)) {
      if (!m[2].includes(path)) continue;
      const hook = m[1];
      for (const f of WEB) {
        if (f.file !== holder.file && new RegExp(`\\b${hook}\\b`).test(f.src)) surfaces.push(f.file);
      }
    }
  }
  return [...new Set(surfaces)];
}

describe("#653: every enrolment surface offers both ways in", () => {
  const routes = routesMintingAnEnrolmentUri();

  it("finds the enrolment endpoints by what they build, not by a list", () => {
    // Guards the sweep itself: if the regex stops matching, everything below passes over an empty set
    // and this file becomes a comment. There are at least two (settings and sign-in) and have been
    // since #652 landed.
    expect(routes.map((r) => `${rel(r.file)} ${r.path}`).sort()).toHaveLength(2);
  });

  it.each(routes)("$path is on a screen that shows a QR AND a typed key", ({ path }) => {
    const surfaces = surfacesReaching(path);
    expect(surfaces.map(rel), `nothing on the web reaches ${path}`).not.toEqual([]);

    // At least one surface must carry both. (More than one component may mention a hook — a test
    // harness, a barrel — so the requirement is that the screen exists, not that every mention is one.)
    const withQr = surfaces.filter((f) => /<QrCode\b/.test(readFileSync(f, "utf8")));
    const withKey = surfaces.filter((f) => /<OneTimeSecret\b/.test(readFileSync(f, "utf8")));

    expect(withQr.map(rel), `${path}: no screen draws a QR — a camera cannot enrol here`)
      .not.toEqual([]);
    expect(withKey.map(rel), `${path}: no screen shows the key — a reader without a camera cannot enrol here`)
      .not.toEqual([]);
    // The coincidence, which is the actual claim: the SAME screen does both.
    expect(withQr.filter((f) => withKey.includes(f)).map(rel),
      `${path}: the QR and the typed key are on different screens`).not.toEqual([]);
  });

  it("draws the QR from the server's own string, never a rebuilt one", () => {
    // the condition. If a screen assembles `otpauth://` itself, the spelling of issuer, digits and
    // period lives in two places, and the day they drift the QR sets up one account while the key
    // typed underneath it sets up another — with both screens looking correct.
    const rebuilders = WEB.filter((f) => f.src.includes("otpauth://"));
    expect(rebuilders.map((f) => rel(f.file)),
      "a web file builds an otpauth:// URI; the server already returns one").toEqual([]);
  });
});
