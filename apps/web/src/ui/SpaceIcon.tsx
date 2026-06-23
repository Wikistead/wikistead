import { Avatar } from "./Avatar";

// Space icon. A rounded-square chip (reads as an object, not a person) built on the
// shared Avatar. Two tiers: an uploaded image (#6) ▷ a deterministic initials chip
// from the space name. (The text-glyph override was removed — image or initials only.)
// The colour is seeded from the stable space id, so renaming keeps the colour and only
// the initials change.
export function SpaceIcon({ id, name, image, size = 20, ...rest }: { id: string; name: string; image?: string | null; size?: number; "data-testid"?: string }) {
  return <Avatar shape="rounded" name={name} seed={id} src={image} size={size} data-testid={rest["data-testid"]} />;
}
