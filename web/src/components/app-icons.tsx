import {
  Ellipsis as EllipsisSource,
  FilePen as FilePenSource,
  FileText as FileTextSource,
  Folder as FolderSource,
  KeyRound as KeyRoundSource,
  Library as LibrarySource,
  Lock as LockSource,
  Plug as PlugSource,
  Tag as TagSource,
  UserRound as UserRoundSource,
} from "lucide-react";
import { icon } from "@/components/ui/icons";

/**
 * The glyphs this app uses that `@cubeui/icons` does not ship. Wrapped here rather than added to
 * `ui/icons.tsx`, which the next `shadcn add @cubeui/icons` overwrites.
 */
export const Ellipsis = icon(EllipsisSource);
/** Rename or move a note. */
export const FilePen = icon(FilePenSource);
export const FileText = icon(FileTextSource);
export const Folder = icon(FolderSource);
export const KeyRound = icon(KeyRoundSource);
export const Library = icon(LibrarySource);
export const Lock = icon(LockSource);
/** A folder served over MCP. */
export const Plug = icon(PlugSource);
export const Tag = icon(TagSource);
/** A human-only folder: searchable here, never shown to agents. */
export const UserRound = icon(UserRoundSource);
