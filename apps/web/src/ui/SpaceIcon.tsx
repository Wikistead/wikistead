import { Avatar } from "./Avatar";

// #4/#6 space icon. A rounded-square chip (reads as an object, not a person) built on
// the shared Avatar. Precedence: uploaded image (#6) ▷ override glyph (#4) ▷ a
// deterministic initials chip from the space name. The colour is seeded from the stable
// space id, so renaming a space keeps its colour and only the initials change.
export function SpaceIcon({ id, name, icon, image, size = 20, ...rest }: { id: string; name: string; icon?: string | null; image?: string | null; size?: number; "data-testid"?: string }) {
  return <Avatar shape="rounded" name={name} seed={id} src={image} glyph={icon} size={size} data-testid={rest["data-testid"]} />;
}
