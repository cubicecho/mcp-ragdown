import {
  FileText as FileTextSource,
  KeyRound as KeyRoundSource,
  Library as LibrarySource,
  Lock as LockSource,
} from "lucide-react";
import { icon } from "@/components/ui/icons";

/**
 * The glyphs this app uses that `@cubeui/icons` does not ship. Wrapped here rather than added to
 * `ui/icons.tsx`, which the next `shadcn add @cubeui/icons` overwrites.
 */
export const FileText = icon(FileTextSource);
export const KeyRound = icon(KeyRoundSource);
export const Library = icon(LibrarySource);
export const Lock = icon(LockSource);
