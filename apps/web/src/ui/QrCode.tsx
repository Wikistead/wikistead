import { useEffect, useRef } from "react";

// #653 (user ruling, 2026-08-06): the QR an authenticator app reads.
//
// `qr-creator` (MIT, 126 KB, no dependencies) rather than a hand-rolled encoder: QR carries
// Reed-Solomon and mask selection, which is the family ADR-219 §9 named when it said nobody should
// re-derive WebAuthn's attestation parsing. TOTP went the other way because it is sixty lines with
// published test vectors — the distinction is kept on purpose.
//
// BLACK ON WHITE, always, and the theme tokens are deliberately not used. A QR read depends on the
// contrast between the two, and a dark theme that inverted it would produce a code a phone cannot see —
// a failure that looks like a working page. The white quiet zone around it is part of the format, not
// padding: scanners need it to find the edges.
export function QrCode({ value, size = 168, testId }: { value: string; size?: number; testId?: string }) {
  const host = useRef<HTMLDivElement>(null);

  // The encoder is fetched WHEN A CODE IS DRAWN, not when this module is imported. `qr-creator` ships a
  // UMD bundle that touches `self` at load, so a static import puts a browser global in the import graph
  // of everything that transitively reaches this file — which took out two pure-function tests of
  // `LoginScreen` running under Node, neither of them about QR codes. It also keeps 126 KB out of the
  // initial chunk for the two screens in the product that ever draw one.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let live = true;
    void import("qr-creator").then(({ default: QrCreator }) => {
      if (!live || !host.current) return;
      host.current.replaceChildren();
      QrCreator.render(
        { text: value, radius: 0, ecLevel: "M", fill: "#000000", background: "#ffffff", size },
        host.current,
      );
    });
    return () => { live = false; };
  }, [value, size]);

  return (
    <div
      ref={host}
      // the quiet zone, in the same white the modules sit on
      className="w-fit rounded-sm bg-white p-3"
      data-testid={testId}
      // What was actually encoded, for a pin that must not settle for "an image appeared": a canvas
      // with the wrong string in it looks exactly like one with the right string in it.
      data-qr-value={value}
      aria-hidden
    />
  );
}
