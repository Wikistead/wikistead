import type { ComponentProps } from "react";
import { Input as ShadInput } from "../components/ui/input";
import { cn } from "../lib/utils";

// App Input wrapper over the shadcn/Radix-style Input (border, focus ring, aria-invalid
// error state). Keeps the shadcn body pristine; passes through all native props
// (data-testid/aria/value/onChange/placeholder/type) so callers and validation are
// unchanged. `inputSize="sm"` for compact inline fields (toolbars/inline rows).
export function Input({ inputSize = "md", className, ...props }: { inputSize?: "sm" | "md" } & ComponentProps<"input">) {
  return <ShadInput className={cn(inputSize === "sm" && "h-8 text-sm", className)} {...props} />;
}
