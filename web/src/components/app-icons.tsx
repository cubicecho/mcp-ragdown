import {
  ArrowDownWideNarrow as ArrowDownWideNarrowSource,
  FilePen as FilePenSource,
  FilePlus as FilePlusSource,
  File as FileSource,
  FolderPen as FolderPenSource,
  Library as LibrarySource,
  UserRound as UserRoundSource,
} from "lucide-react";
import { icon } from "@/components/ui/icons";

/**
 * The glyphs this app uses that `@cubeui/icons` does not ship. Wrapped here rather than added to
 * `ui/icons.tsx`, which the next `shadcn add @cubeui/icons` overwrites.
 */
/** How the file list is sorted. */
export const ArrowDownWideNarrow = icon(ArrowDownWideNarrowSource);
/** A file in the file tree. */
export const File = icon(FileSource);
/** Rename or move a note. */
export const FilePen = icon(FilePenSource);
/** A new note in a subfolder. */
export const FilePlus = icon(FilePlusSource);
/** Rename a folder's directory. */
export const FolderPen = icon(FolderPenSource);
export const Library = icon(LibrarySource);
/** A human-only folder: searchable here, never shown to agents. */
export const UserRound = icon(UserRoundSource);
