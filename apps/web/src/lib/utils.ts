import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn class-name helper: merge conditional classes and de-conflict Tailwind
// utilities (last-wins for the same property). Used by every shadcn/wrapper component.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
