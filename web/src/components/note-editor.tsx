import { useMemo } from "react";
import {
  MarkdownCodeEditor,
  type MarkdownCodeEditorProps,
} from "@/components/markdown-code-editor";
import { wikilinkCompletion } from "@/lib/wikilink-completion";

/**
 * cubeui's `MarkdownCodeEditor` with the one thing the app adds: `[[` completes to a note of the
 * folder. Its own chunk (see `DocEditor`), with all of CodeMirror in it, so reading notes never
 * downloads either.
 */
export default function NoteEditor({
  notes,
  ...editor
}: Omit<MarkdownCodeEditorProps, "extensions"> & {
  /** The folder's notes, relative to it, which `[[` offers to link to. */
  notes: readonly string[];
}) {
  const wikilinks = useMemo(() => wikilinkCompletion(notes), [notes]);
  return <MarkdownCodeEditor {...editor} extensions={wikilinks} />;
}
