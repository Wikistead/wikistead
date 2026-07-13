import { useState, type CSSProperties } from "react";
import { colorFromString, initials } from "./avatar";
import { cn } from "../lib/utils";

// Shared avatar used by #3 (user), #4 (space icon), #8 (collab cursor). Renders the
// `src` picture when present, else a deterministic initials chip. The picture is
// loaded by the browser directly via <img src> — NO server proxy — so it cannot be
// used to make the server fetch attacker-controlled URLs (no SSRF). If the image
// fails to load (404, hotlink block, dead IdP URL) we fall back to the initials chip,
// so a broken picture URL never leaves a blank hole.
export interface AvatarProps {
  // The identity string the chip is rendered from: initials + a stable colour. For a
  // user this is the display name; for a space, its name.
  name: string;
  // Optional picture URL. null/undefined → initials chip.
  src?: string | null;
  // Stable seed for the colour. Defaults to `name`, but pass a more stable id (a
  // user's sub, a space id) so a rename doesn't recolour the avatar.
  seed?: string;
  // Verbatim glyph override (an emoji / short label) shown instead of the computed
  // initials. Used by the #4 space-icon override. `src` (a picture) still wins.
  glyph?: string | null;
  size?: number; // px (width = height). Default 24.
  shape?: "circle" | "rounded"; // circle = person (default), rounded = space/object
  title?: string;
  className?: string;
  "data-testid"?: string;
}

export function Avatar({ name, src, seed, glyph, size = 24, shape = "circle", title, className, ...rest }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImg = src && !failed;
  const style: CSSProperties = {
    width: size,
    height: size,
    // #284NO Math.round — rounding made the font/box ratio drift per size (0.40–0.444), so the same
    // space's chip wasn't a clean scaled version across call-sites (14px pin row vs 18px switcher). A fractional
    // px keeps the ratio EXACTLY constant (0.42 / 0.55 glyph) at every size, so every chip is a proportional scale.
    fontSize: size * (glyph ? 0.55 : 0.42),
    background: showImg ? undefined : colorFromString(seed ?? name),
  };
  const cls = cn(
    // #288: whitespace-nowrap so a 2-glyph monogram can never WRAP to two stacked rows (which the fixed
    // px box + overflow-hidden then clipped, making the same name look different per call-site size). It
    // stays on one line and clips horizontally if it ever overflows.
    "inline-flex flex-none select-none items-center justify-center overflow-hidden whitespace-nowrap font-semibold uppercase leading-none text-white",
    shape === "rounded" ? "rounded-[24%]" : "rounded-full", // rounded square = object/space; circle = person
    className,
  );
  return (
    <span className={cls} style={style} title={title ?? name} aria-label={title ?? name} role="img" data-testid={rest["data-testid"]}>
      {showImg ? (
        // referrerPolicy: don't leak the app URL to the IdP/CDN serving the picture.
        <img className="block h-full w-full object-cover" src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        glyph || initials(name)
      )}
    </span>
  );
}
