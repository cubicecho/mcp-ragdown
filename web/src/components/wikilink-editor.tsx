import { useMemo } from "react";
import {
  MarkdownCodeEditor,
  type MarkdownCodeEditorProps,
} from "@/components/markdown-code-editor";
import { wikilinkCompletion } from "@/lib/wikilink-completion";

/**
 * cubeui's `MarkdownCodeEditor` with the one thing the app adds: `[[` completes to a document of the
 * folder. Its own chunk (see `DocEditor`), with all of CodeMirror in it, so reading documents never
 * downloads either.
 */
export default function WikilinkEditor({
  documents,
  ...editor
}: Omit<MarkdownCodeEditorProps, "extensions"> & {
  /** The folder's documents, relative to it, which `[[` offers to link to. */
  documents: readonly string[];
}) {
  const wikilinks = useMemo(() => wikilinkCompletion(documents), [documents]);
  return <MarkdownCodeEditor {...editor} extensions={wikilinks} />;
}
