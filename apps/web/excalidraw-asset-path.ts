// #990 / ADR-277: the ONE place `EXCALIDRAW_ASSET_PATH` is declared. Split out of `csp-policy.ts`
// (2026-09-02, review finding 3 fix) because that file imports `node:fs` /
// `node:module` for its Vite build-time plugins — fine for a config file, fatal for this constant,
// which `excalidraw.ts` also needs at runtime IN THE BROWSER (`vite build` externalizes those Node
// built-ins for the browser bundle and the build fails outright rather than silently). This file has
// no imports of its own on purpose: it must stay safe to import from both sides.
export const EXCALIDRAW_ASSET_PATH = "/excalidraw/";
