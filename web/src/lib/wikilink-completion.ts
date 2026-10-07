import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";

/**
 * What `[[` offers: each document by the shortest name that finds it, as a wikilink resolves — the
 * file name when no other document shares it, else as much of the path as tells them apart.
 *
 * @param documents paths relative to the folder, with `.md`.
 */
export function wikilinkOptions(documents: readonly string[]): Completion[] {
  const bare = documents.map((path) => path.replace(/\.md$/i, ""));
  return bare.map((path, index) => {
    const parts = path.split("/");
    let label = path;
    for (let take = 1; take <= parts.length; take++) {
      const tail = parts.slice(-take).join("/").toLowerCase();
      const clashes = bare.some(
        (other, at) =>
          at !== index &&
          (other.toLowerCase() === tail || other.toLowerCase().endsWith(`/${tail}`)),
      );
      if (!clashes) {
        label = parts.slice(-take).join("/");
        break;
      }
    }
    return { label, detail: label === path ? undefined : path, type: "text" };
  });
}

/** Completes a wikilink's target, from `[[` up to a `|`, `#` or the closing `]]`. */
function wikilinkSource(options: readonly Completion[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^\]|#\n]*$/);
    if (!before) return null;
    const after = context.state.sliceDoc(context.pos, context.pos + 2);
    return {
      from: before.from + 2,
      options: options.map((option) => ({
        ...option,
        // Close the link, unless it already is.
        apply: after === "]]" ? option.label : `${option.label}]]`,
      })),
      validFor: /^[^\]|#\n]*$/,
    };
  };
}

/**
 * The one thing the app adds to cubeui's `MarkdownCodeEditor`: `[[` completes to a document of the
 * folder.
 *
 * @param documents paths relative to the folder, with `.md`.
 */
export function wikilinkCompletion(documents: readonly string[]): Extension {
  return autocompletion({ override: [wikilinkSource(wikilinkOptions(documents))], icons: false });
}
