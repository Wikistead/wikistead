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

// #284 the glyph is ALWAYS drawn at this fixed px (comfortably above every browser's minimum-font-size
// floor, which in ja/CJK locales Chrome enforces at ~10px) and then shrunk to the target with a CSS `transform:
// scale()`. The floor clamps `font-size` but NOT transforms, so a small chip (14px box → 5.88px target) that used
// to get re-clamped to 10px — re-breaking the font/box ratio the fractional font had fixed — now stays a
// pure proportional scale of the same 16px glyph at EVERY call-site size, floor or no floor.
const GLYPH_BASE_PX = 16;

export function Avatar({ name, src, seed, glyph, size = 24, shape = "circle", title, className, ...rest }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImg = src && !failed;
  const style: CSSProperties = {
    width: size,
    height: size,
    background: showImg ? undefined : colorFromString(seed ?? name),
  };
  // #284 → keep the font/box ratio EXACTLY constant (0.42 / 0.55 glyph) at every size — but achieve
  // the sub-floor sizes via a transform scale of the fixed-size glyph rather than a fractional font-size that the
  // browser floor would clamp. transform-origin defaults to center; the outer flex centres the base glyph box.
  const glyphScale = (size * (glyph ? 0.55 : 0.42)) / GLYPH_BASE_PX;
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
        // inline-block: `transform` does not apply to non-replaced inline boxes, so the glyph must be a block box.
        <span className="inline-block leading-none" style={{ fontSize: GLYPH_BASE_PX, transform: `scale(${glyphScale})` }}>
          {glyph || initials(name)}
        </span>
      )}
    </span>
  );
}
