import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { createContext, useContext, useId, useMemo } from "react";
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
  type ExtraProps,
  type Options,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { Checkbox } from "@/components/ui/checkbox";
import { Code, CodeBlock } from "@/components/ui/code";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * How blocks follow one another: a column with one gap, in the document and again inside a
 * quotation.
 *
 * A gap rather than margins, and every block below says `m-0`, so the rhythm does not depend on
 * what the page's stylesheet did to `<p>`, `<ul>` and `<blockquote>` first. Tailwind's preflight
 * zeroes their margins and an app without it leaves the browser's; under either, a block's
 * distance from the next is this gap and nothing else.
 */
const FLOW = "flex flex-col gap-3";

/**
 * The document's own type and rhythm, and the two looks that are worn from here rather than by an
 * element.
 *
 * Links and images are styled from the root on purpose. They are the two elements an app replaces
 * — a link becomes the router's `<Link>`, an image becomes one the app resolves and signs — and a
 * replacement handed in through `components` should not have to copy a class string to look like
 * the link it replaced.
 *
 * `wrap-anywhere` because the text is someone else's: one long URL in a paragraph otherwise widens
 * the document past the pane it is in.
 */
const DOCUMENT = cn(
  FLOW,
  "min-w-0 text-sm leading-relaxed text-foreground wrap-anywhere",
  "[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
  "[&_img]:inline-block [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-md",
);

/**
 * The heading scale, which is `PageHeader`'s carried on down: a document's `#` is the same size as
 * a page's title, so a rendered file and the page around it are one hierarchy and not two.
 */
const HEADINGS = {
  1: "text-xl",
  2: "text-lg",
  3: "text-base",
  4: "text-sm",
  5: "text-sm",
  6: "text-sm text-muted-foreground",
} as const;

type Level = keyof typeof HEADINGS;

/** The syntax-tree node react-markdown hands every element, which is where its text is read from. */
type SyntaxNode = NonNullable<ExtraProps["node"]>;

/** The text of a node and everything in it, as written: what a fenced block or a heading says. */
function textOf(node: SyntaxNode | SyntaxNode["children"][number] | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

/** What `Markdown` tells the elements inside it. Only the heading ids, so far. */
const HeadingIdContext = createContext<MarkdownProps["headingId"]>(undefined);

/** The id of the task-list item a checkbox sits in, which is what names the checkbox. */
const TaskItemContext = createContext<string | undefined>(undefined);

function Heading({
  level,
  node,
  children,
}: {
  level: Level;
  node: SyntaxNode | undefined;
  children?: ReactNode;
}) {
  const headingId = useContext(HeadingIdContext);
  const Tag = `h${level}` as const;
  return (
    <Tag
      id={headingId?.(textOf(node))}
      className={cn(
        // More room above than below, so a heading belongs to what follows it. `scroll-mt` is for
        // the heading that is a link's target: it lands clear of the edge rather than under it.
        "mt-3 mb-0 scroll-mt-4 font-semibold tracking-tight first:mt-0",
        HEADINGS[level],
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * A list. A task list drops its bullets and its indent: the checkboxes are the markers.
 * `contains-task-list` is the class remark-gfm puts on a list that holds one.
 */
function List({
  ordered,
  className,
  start,
  children,
}: {
  ordered: boolean;
  className: string | undefined;
  start?: number | undefined;
  children?: ReactNode;
}) {
  const tasks = className?.includes("contains-task-list");
  const look = cn(
    "m-0",
    tasks ? "list-none pl-0" : ["pl-6", ordered ? "list-decimal" : "list-disc"],
  );
  return ordered ? (
    <ol start={start} className={look}>
      {children}
    </ol>
  ) : (
    <ul className={look}>{children}</ul>
  );
}

/** A list item, which for a task item is also the name of the checkbox in it. */
function ListItem({ className, children }: ComponentPropsWithoutRef<"li">) {
  const id = useId();
  // Items a little apart, a nested list a little under its item, and the paragraphs of a loose
  // item apart from each other.
  const look = "mt-1 first:mt-0 [&>ol]:mt-1 [&>p+p]:mt-2 [&>ul]:mt-1";
  if (!className?.includes("task-list-item")) return <li className={look}>{children}</li>;
  return (
    <li id={id} className={look}>
      <TaskItemContext.Provider value={id}>{children}</TaskItemContext.Provider>
    </li>
  );
}

/**
 * A task item's box. Markdown writes it as `- [x]`, and it is drawn as the registry's `Checkbox`
 * so a rendered checklist matches a form's — disabled, because the document is being read, not
 * filled in: ticking it here would change nothing in the source.
 */
function TaskBox({ checked }: ComponentPropsWithoutRef<"input">) {
  const item = useContext(TaskItemContext);
  return (
    <Checkbox
      checked={Boolean(checked)}
      disabled
      aria-labelledby={item}
      className="mr-2 inline-flex align-text-bottom"
    />
  );
}

/**
 * The element map: what each piece of Markdown is drawn as.
 *
 * Declared once, at the top level, rather than built inside the component. react-markdown mounts
 * whatever it is handed as a component, so a map rebuilt on every render is a new set of component
 * types every render, and the whole document remounts on each keystroke of an editor beside it.
 *
 * Emphasis, strong text and strikethrough are absent because the browser's own are right; links are absent, and images wear no class, because the root styles both (see
 * {@link DOCUMENT}).
 */
const ELEMENTS: Components = {
  h1: ({ node, children }) => (
    <Heading level={1} node={node}>
      {children}
    </Heading>
  ),
  h2: ({ node, children }) => (
    <Heading level={2} node={node}>
      {children}
    </Heading>
  ),
  h3: ({ node, children }) => (
    <Heading level={3} node={node}>
      {children}
    </Heading>
  ),
  h4: ({ node, children }) => (
    <Heading level={4} node={node}>
      {children}
    </Heading>
  ),
  h5: ({ node, children }) => (
    <Heading level={5} node={node}>
      {children}
    </Heading>
  ),
  h6: ({ node, children }) => (
    <Heading level={6} node={node}>
      {children}
    </Heading>
  ),
  p: ({ children }) => <p className="m-0">{children}</p>,
  ul: ({ className, children }) => (
    <List ordered={false} className={className}>
      {children}
    </List>
  ),
  ol: ({ className, start, children }) => (
    <List ordered className={className} start={start}>
      {children}
    </List>
  ),
  li: ({ className, children }) => <ListItem className={className}>{children}</ListItem>,
  input: ({ checked }) => <TaskBox checked={checked} />,
  blockquote: ({ children }) => (
    <blockquote className={cn(FLOW, "m-0 border-border border-l-2 pl-4 text-muted-foreground")}>
      {children}
    </blockquote>
  ),
  // A code span. A fenced block's `<code>` never reaches here: `pre` below draws the whole block
  // from the syntax tree and does not render its children.
  code: ({ children }) => <Code>{children}</Code>,
  // A fenced or indented block. Its text is read from the tree rather than from `children`,
  // because `CodeBlock` takes a string — whitespace is the one thing a block of code cannot have
  // rearranged. The last newline is the fence's, not the code's.
  pre: ({ node }) => <CodeBlock content={textOf(node).replace(/\n$/, "")} />,
  hr: () => <Separator decorative={false} />,
  // Only to drop a blanked address. The URL policy turns an unsafe `src` into `""`, and an image
  // with an empty `src` asks the browser for the page it is on. Its look is the root's.
  img: ({ src, alt, title }) => <img src={src || undefined} alt={alt ?? ""} title={title} />,
  table: ({ children }) => <Table>{children}</Table>,
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  // `style` is the column's alignment (`:--`, `:-:`, `--:`), which is the only style Markdown can
  // write. A data table keeps a cell on one line; a document's cell is prose, so it wraps — at
  // its words, not anywhere as the document's text does, or a column in a narrow pane shrinks to
  // a letter wide. A table too wide for the pane scrolls inside `Table`'s own container.
  th: ({ style, children }) => (
    <TableHead style={style} className="wrap-normal whitespace-normal">
      {children}
    </TableHead>
  ),
  td: ({ style, children }) => (
    <TableCell style={style} className="wrap-normal whitespace-normal">
      {children}
    </TableCell>
  ),
};

/** remark-gfm first, always: tables, task lists, strikethrough and bare links are part of the map. */
const GFM: NonNullable<Options["remarkPlugins"]> = [remarkGfm];

export type MarkdownProps = {
  /** The Markdown source, as a string. */
  content: string;
  /**
   * What is drawn when `content` is blank: "This file is empty.", "Nothing to preview yet." Left
   * out, a blank document draws nothing.
   */
  empty?: ReactNode;
  /**
   * An id for each heading, worked out from its text, so a table of contents or a `#fragment` can
   * point at one. Return `undefined` to leave a heading without. Left out, no heading has an id:
   * an id is a promise the page makes about what is unique on it, and only the app knows that.
   */
  headingId?: ((text: string) => string | undefined) | undefined;
  /**
   * Elements to draw differently, by tag — react-markdown's own `components`, laid over this
   * component's map. It is how an app's router `<Link>` becomes `a`, or an image is resolved
   * before it is drawn. A replaced `a` or `img` keeps the document's look, which is worn from the
   * root.
   */
  components?: Components | undefined;
  /**
   * remark plugins to run after remark-gfm — react-markdown's own `remarkPlugins`. A wikilink
   * syntax, a footnote style. There is no `rehypePlugins`: see the note on raw HTML below.
   */
  remarkPlugins?: Options["remarkPlugins"] | undefined;
  /**
   * What a link's or an image's URL becomes before it is drawn — react-markdown's own
   * `urlTransform`. The default is react-markdown's `defaultUrlTransform`, which keeps `http`,
   * `https`, `mailto` and relative URLs and blanks the rest, `javascript:` among them. Replace it
   * to let a scheme of your own through, and hand everything else back to `defaultUrlTransform`.
   */
  urlTransform?: Options["urlTransform"] | undefined;
  /** The document's root: its width, its margin. */
  className?: string | undefined;
};

/**
 * A Markdown string, rendered: the reader of a note, a README, a skill, a model's answer.
 *
 * It is the element map and nothing else. Every element is drawn from the theme's tokens and from
 * the primitives the rest of an app already uses — a fenced block is a `CodeBlock`, a code span a
 * `Code`, a table the registry's `Table`, a rule a `Separator`, a task item a `Checkbox` — so a
 * rendered document cannot drift from the page around it. That drift is the whole reason this is a
 * component: each app's hand-kept map chose its own blockquote rule and its own heading scale.
 *
 * GitHub-flavoured Markdown is on: tables, task lists, strikethrough, bare links.
 *
 * **Raw HTML is never rendered.** Markdown may hold HTML, and here it is shown as the text it is.
 * There is no prop that turns it on, because the content is as often someone else's as the
 * caller's — a file from a repository, text a model wrote — and HTML from there is script
 * injection. An app that must render trusted HTML is using react-markdown directly, with
 * `rehype-raw` and a sanitiser it chose.
 *
 * **URLs are filtered** by {@link MarkdownProps.urlTransform}, which blanks anything that is not a
 * web, mail or relative URL unless the caller says otherwise.
 *
 * There is no syntax highlighting, which `CodeBlock` does not have either.
 */
export function Markdown({
  content,
  empty,
  headingId,
  components,
  remarkPlugins,
  urlTransform = defaultUrlTransform,
  className,
}: MarkdownProps) {
  const elements = useMemo(
    () => (components ? { ...ELEMENTS, ...components } : ELEMENTS),
    [components],
  );
  const plugins = useMemo(
    () => (remarkPlugins ? [...GFM, ...remarkPlugins] : GFM),
    [remarkPlugins],
  );

  if (content.trim() === "") {
    // Rule 5 — an absent slot draws nothing, and that includes the root.
    return empty ? (
      <div data-slot="markdown" className={cn(DOCUMENT, className)}>
        {empty}
      </div>
    ) : null;
  }

  return (
    <div data-slot="markdown" className={cn(DOCUMENT, className)}>
      <HeadingIdContext.Provider value={headingId}>
        <ReactMarkdown remarkPlugins={plugins} urlTransform={urlTransform} components={elements}>
          {content}
        </ReactMarkdown>
      </HeadingIdContext.Provider>
    </div>
  );
}
