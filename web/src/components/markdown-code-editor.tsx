import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, type TagStyle } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  placeholder as cmPlaceholder,
  EditorView,
  highlightActiveLine,
  keymap,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * The editor's colours, read from the theme's variables and nothing else: it follows light, dark
 * and the palette with the rest of the page, and there is no CodeMirror theme to keep in step.
 *
 * The selection is the browser's own, so it is drawn by the same `::selection` rule as the text
 * around the editor.
 */
const theme = EditorView.theme({
  "&": { color: "var(--foreground)", backgroundColor: "transparent", fontSize: "0.875rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    lineHeight: "1.6",
  },
  ".cm-content": { caretColor: "var(--foreground)", padding: "0.5rem 0" },
  ".cm-line": { padding: "0 0.75rem" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-placeholder": { color: "color-mix(in oklab, var(--foreground) 60%, transparent)" },
  // What an app's own completion or lint extension draws: a popover, in the popover's colours.
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "inherit", maxHeight: "16rem" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "0.25rem 0.5rem" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--active)",
    color: "var(--active-foreground)",
  },
  ".cm-completionDetail": {
    color: "color-mix(in oklab, currentColor 60%, transparent)",
    fontStyle: "normal",
  },
});

const QUIET = "color-mix(in oklab, var(--foreground) 60%, transparent)";

/** Markdown's structure, muted, so the prose stays the thing you read. */
const HIGHLIGHT_RULES: readonly TagStyle[] = [
  { tag: tags.heading, fontWeight: "600" },
  // A tag takes the one most specific rule, not every rule that fits: without the weight here a
  // first-level heading would be the only heading that is not bold.
  { tag: tags.heading1, fontWeight: "600", fontSize: "1.15em" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--info)", textDecoration: "underline" },
  {
    tag: [tags.processingInstruction, tags.meta, tags.contentSeparator, tags.quote],
    color: QUIET,
  },
  { tag: tags.monospace, color: "var(--info)" },
  { tag: [tags.keyword, tags.tagName], color: "var(--info)", fontWeight: "500" },
  { tag: [tags.string, tags.attributeValue], color: "var(--positive)" },
  { tag: tags.comment, color: QUIET, fontStyle: "italic" },
];

const highlight = HighlightStyle.define(HIGHLIGHT_RULES);

/** Marks a change this component made to follow `value`, which is not an edit to report. */
const fromValue = Annotation.define<boolean>();

/**
 * One compartment per prop the editor can be handed again. Reconfiguring a compartment changes
 * that one thing and keeps the document, the cursor and the undo history; rebuilding the view
 * would lose all three on a prop as small as `readOnly`.
 */
const ACCESSIBLE_NAME = new Compartment();
const READ_ONLY = new Compartment();
const PLACEHOLDER = new Compartment();
const EXTENSIONS = new Compartment();

function accessibleName(label: string | undefined, labelledBy: string | undefined): Extension {
  return EditorView.contentAttributes.of({
    ...(label === undefined ? {} : { "aria-label": label }),
    ...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy }),
  });
}

export type MarkdownCodeEditorProps = {
  /**
   * The Markdown source. The caller holds it; a value that is not what the editor shows replaces
   * the document, which is how opening another file works.
   */
  value: string;
  /** Called with the whole source on every edit. */
  onValueChange: (value: string) => void;
  /**
   * Cmd+S or Ctrl+S, with the source as it stands. Given, the key is the editor's and the browser
   * does not offer to save the page; left out, the key is the browser's.
   */
  onSave?: ((value: string) => void) | undefined;
  /** The editor's accessible name: "Instructions". Pass this or `aria-labelledby`. */
  label?: string | undefined;
  /** The id of a visible label, where there is one, instead of `label`. */
  "aria-labelledby"?: string | undefined;
  /** Shows the source, selectable and copyable, and refuses edits. */
  readOnly?: boolean | undefined;
  /** What an empty document shows. */
  placeholder?: string | undefined;
  /**
   * CodeMirror extensions of the app's own: a completion source, a linter, a keymap. They come
   * before the editor's, so a key an app binds wins over the same key here. Hold the array in a
   * constant or `useMemo`: a new one each render reconfigures the editor each render.
   */
  extensions?: Extension | undefined;
  /** Puts the cursor in the editor when it mounts. */
  autoFocus?: boolean | undefined;
  /** The editor's box: its height, its width. Sixteen rem tall at least unless told otherwise. */
  className?: string | undefined;
};

/**
 * A Markdown source editor on CodeMirror 6, for the app whose job is editing Markdown files.
 *
 * It is a source editor, not a rich-text one: a rich editor rewrites what it does not understand,
 * and a document's wikilinks, embeds and front matter have to come back byte for byte. What it
 * adds to a textarea is syntax highlighting (fenced code included), soft wrap, list continuation,
 * a real undo history, a save key and room for an app's own extensions.
 *
 * - **The value is the caller's** (`value`, `onValueChange`), as with every other control.
 * - **It is heavy** — CodeMirror is most of half a megabyte before gzip — so it is a default
 *   export, to be loaded with `lazy()` behind a `Skeleton`. A short field wants `MarkdownEditor`,
 *   which is a textarea.
 * - **Keep it mounted** to keep its undo history and cursor: hide it while a preview shows, do
 *   not unmount it.
 */
export function MarkdownCodeEditor({
  value,
  onValueChange,
  onSave,
  label,
  "aria-labelledby": labelledBy,
  readOnly = false,
  placeholder,
  extensions,
  autoFocus = false,
  className,
}: MarkdownCodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  // Read through a ref: the view is built once, and these change on every render.
  const latest = useRef({ value, onValueChange, onSave, autoFocus });
  latest.current = { value, onValueChange, onSave, autoFocus };

  useEffect(() => {
    if (host.current === null) {
      return;
    }
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          // Each compartment is given its real content by the effects below, which also run on
          // mount. The app's extensions lead, so its keys are tried before the editor's.
          EXTENSIONS.of([]),
          history(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: "true" }),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(highlight),
          theme,
          keymap.of([
            {
              key: "Mod-s",
              run: (target) => {
                const save = latest.current.onSave;
                if (save === undefined) {
                  return false;
                }
                save(target.state.doc.toString());
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            const reported = update.transactions.some((tr) => tr.annotation(fromValue) === true);
            if (update.docChanged && reported === false) {
              latest.current.onValueChange(update.state.doc.toString());
            }
          }),
          ACCESSIBLE_NAME.of([]),
          READ_ONLY.of([]),
          PLACEHOLDER.of([]),
        ],
      }),
    });
    editor.current = view;
    if (latest.current.autoFocus) {
      view.focus();
    }
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (view === null) {
      return;
    }
    const shown = view.state.doc.toString();
    if (shown !== value) {
      view.dispatch({
        changes: { from: 0, to: shown.length, insert: value },
        annotations: fromValue.of(true),
      });
    }
  }, [value]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: ACCESSIBLE_NAME.reconfigure(accessibleName(label, labelledBy)),
    });
  }, [label, labelledBy]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: READ_ONLY.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: PLACEHOLDER.reconfigure(placeholder === undefined ? [] : cmPlaceholder(placeholder)),
    });
  }, [placeholder]);

  useEffect(() => {
    editor.current?.dispatch({ effects: EXTENSIONS.reconfigure(extensions ?? []) });
  }, [extensions]);

  return (
    <div
      ref={host}
      data-slot="markdown-code-editor"
      className={cn(
        "min-h-64 w-full min-w-0 overflow-hidden rounded-md border border-foreground/15 bg-background text-foreground focus-within:border-active",
        // The view fills the box, so a click below the last line still lands in the editor.
        "[&>.cm-editor]:h-full [&>.cm-editor]:min-h-[inherit]",
        className,
      )}
    />
  );
}

export default MarkdownCodeEditor;
