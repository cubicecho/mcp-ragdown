import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Row actions that fade in on hover.
 *
 * There is no hover off web, so the class that hides them would hide them for
 * good — on native they are simply always visible. Kept here rather than inline
 * so no component has to reach for `Platform` to express it.
 */
export const HOVER_REVEAL = "opacity-0 transition-opacity group-hover:opacity-100";
