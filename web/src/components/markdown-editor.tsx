import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

/**
 * The editor's colours, from the app's theme variables: it follows light and dark with the rest
 * of the page and has no theme of its own to keep in step.
 */
const theme = EditorView.theme({
  "&": { color: "var(--foreground)", backgroundColor: "transparent", fontSize: "0.875rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    lineHeight: "1.6",
  },
  ".cm-content": { caretColor: "var(--foreground)", padding: "0" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--accent) 60%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklch, var(--ring) 35%, transparent) !important",
  },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "calc(var(--radius) - 2px)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "inherit", maxHeight: "16rem" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "0.25rem 0.5rem" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionDetail": { color: "var(--muted-foreground)", fontStyle: "normal" },
});

/**
 * What `[[` offers: each note by the shortest name that finds it, as a wikilink resolves — the
 * file name when no other note shares it, else as much of the path as tells them apart.
 *
 * @param notes paths relative to the folder, with `.md`.
 */
export function wikilinkOptions(notes: readonly string[]): Completion[] {
  const bare = notes.map((path) => path.replace(/\.md$/i, ""));
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
function wikilinkSource(options: () => Completion[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^\]|#\n]*$/);
    if (!before) return null;
    const after = context.state.sliceDoc(context.pos, context.pos + 2);
    return {
      from: before.from + 2,
      options: options().map((option) => ({
        ...option,
        // Close the link, unless it already is.
        apply: after === "]]" ? option.label : `${option.label}]]`,
      })),
      validFor: /^[^\]|#\n]*$/,
    };
  };
}

/** Markdown's structure, muted, so the prose stays the thing you read. */
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600" },
  { tag: tags.heading1, fontSize: "1.15em" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--primary)", textDecoration: "underline" },
  {
    tag: [tags.processingInstruction, tags.meta, tags.contentSeparator, tags.quote],
    color: "var(--muted-foreground)",
  },
  { tag: tags.monospace, color: "var(--primary)" },
  { tag: [tags.keyword, tags.tagName], color: "var(--primary)", fontWeight: "500" },
  { tag: [tags.string, tags.attributeValue], color: "oklch(0.55 0.12 150)" },
  { tag: [tags.number, tags.bool, tags.atom], color: "oklch(0.6 0.13 60)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
]);

/**
 * A Markdown source editor: CodeMirror, not a rich-text one, because a rich editor rewrites what
 * it does not understand, and notes are full of wikilinks, embeds and front matter that must
 * come back byte for byte. Uncontrolled: `value` is read once, and every change is reported.
 * Its own chunk (see `DocEditor`), so reading notes never downloads it.
 */
export default function MarkdownEditor({
  value,
  onChange,
  onSave,
  label,
  notes = [],
}: {
  value: string;
  onChange: (text: string) => void;
  /** Ctrl/Cmd+S, which would otherwise save the web page. */
  onSave: () => void;
  label: string;
  /** The folder's notes, relative to it, which `[[` offers to link to. */
  notes?: readonly string[];
}) {
  const host = useRef<HTMLDivElement>(null);
  // Read through refs: the view is built once, and the callbacks change every render.
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const links = useRef<Completion[]>([]);
  useEffect(() => {
    links.current = wikilinkOptions(notes);
  }, [notes]);
  const initial = useRef(value);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "true" }),
          placeholder("Write Markdown…"),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(highlight),
          theme,
          autocompletion({ override: [wikilinkSource(() => links.current)], icons: false }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.focus();
    return () => view.destroy();
  }, [label]);

  return <div ref={host} className="min-h-[60vh]" />;
}
