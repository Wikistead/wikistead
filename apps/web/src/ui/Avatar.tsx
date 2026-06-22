import { useState, type CSSProperties } from "react";
import { colorFromString, initials } from "./avatar";
import styles from "./Avatar.module.css";

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
    fontSize: Math.round(size * (glyph ? 0.55 : 0.42)),
    background: showImg ? undefined : colorFromString(seed ?? name),
  };
  const cls = [styles.avatar, shape === "rounded" ? styles.rounded : styles.circle, className].filter(Boolean).join(" ");
  return (
    <span className={cls} style={style} title={title ?? name} aria-label={title ?? name} role="img" data-testid={rest["data-testid"]}>
      {showImg ? (
        // referrerPolicy: don't leak the app URL to the IdP/CDN serving the picture.
        <img className={styles.img} src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        glyph || initials(name)
      )}
    </span>
  );
}
