import { Avatar } from "./Avatar";

// #4 space icon. A rounded-square chip (reads as an object, not a person) built on the
// shared Avatar: the override glyph if set, else a deterministic initials chip from the
// space name. The colour is seeded from the stable space id, so renaming a space keeps
// its colour and only the initials change.
export function SpaceIcon({ id, name, icon, size = 20, ...rest }: { id: string; name: string; icon?: string | null; size?: number; "data-testid"?: string }) {
  return <Avatar shape="rounded" name={name} seed={id} glyph={icon} size={size} data-testid={rest["data-testid"]} />;
}
