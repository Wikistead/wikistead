import type { ComponentProps } from "react";
import { Input as ShadInput } from "../components/ui/input";
import { cn } from "../lib/utils";
import { useControlScale } from "./FormRow";

// App Input wrapper over the shadcn/Radix-style Input (border, focus ring, aria-invalid
// error state). Keeps the shadcn body pristine; passes through all native props
// (data-testid/aria/value/onChange/placeholder/type) so callers and validation are
// unchanged. `inputSize="sm"` for compact inline fields (toolbars/inline rows).
//
// #535: with no `inputSize` and inside a FormRow, the row's scale decides. This field is what every
// ragged row had in common — authors wrote `size="sm"` on the Button and the Select beside it and missed
// this one, because it is spelled differently and defaults the other way.
export function Input({ inputSize, className, ...props }: { inputSize?: "sm" | "md" } & ComponentProps<"input">) {
  const scale = useControlScale(inputSize, "md");
  return <ShadInput className={cn(scale === "sm" && "h-8 text-sm", className)} {...props} />;
}
