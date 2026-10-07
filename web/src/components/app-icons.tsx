import { FilePlus as FilePlusSource } from "lucide-react";
import { icon } from "@/components/ui/icons";

/**
 * The glyphs this app uses that `@cubeui/icons` does not ship. Wrapped here rather than added to
 * `ui/icons.tsx`, which the next `shadcn add @cubeui/icons` overwrites.
 */
/** A new document in a subfolder. */
export const FilePlus = icon(FilePlusSource);
