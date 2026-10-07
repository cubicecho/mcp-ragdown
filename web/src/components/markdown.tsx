import { Image as ImageIcon, ImageOff } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { createContext, useContext, useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
  type ExtraProps,
  type Options,
  type UrlTransform,
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
import { cn, type SlotNode } from "@/lib/utils";

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
  "[&_a]:font-medium [&_a]:text-info [&_a]:underline [&_a]:underline-offset-4",
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
  6: "text-sm text-foreground/60",
} as const;

type Level = keyof typeof HEADINGS;

/** The syntax-tree node react-markdown hands every element, which is where its text is read from. */
type SyntaxNode = NonNullable<ExtraProps["node"]>;

/** The text of a node and everything in it, as written: what a fenced block or a heading says. */
function textOf(node: SyntaxNode | SyntaxNode["children"][number] | undefined): string {
  if (!node) {
    return "";
  }
  if (node.type === "text") {
    return node.value;
  }
  if (node.type === "element") {
    return node.children.map(textOf).join("");
  }
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
  if (className?.includes("task-list-item") !== true) {
    return <li className={look}>{children}</li>;
  }
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

/** What a link or an image in the document is, as `resolveLink` is told it. */
export type MarkdownLinkKind = "link" | "wikilink" | "image" | "embed";

/**
 * What `resolveLink` answers with: where a target goes, or that it goes nowhere.
 *
 * `href` is used as given — the URL policy ran on what the document wrote, not on what the app
 * answers. `render` is for the link only the app can draw, its router's: it is handed the link's
 * text (an image's alt text) and returns the element.
 */
export type MarkdownLinkResolution =
  | { href: string }
  | { render: (label: ReactNode) => ReactNode }
  | { pending: true }
  | { broken: true; reason?: string | undefined };

type ResolveLink = (
  target: string,
  context: { kind: MarkdownLinkKind },
) => MarkdownLinkResolution | undefined | PromiseLike<MarkdownLinkResolution | undefined>;

/** The private schemes a wikilink travels on between the plugin and the element that draws it. */
const WIKILINK = "wikilink:";
const WIKIEMBED = "wikiembed:";

/** `[[target]]` or `![[target]]`, on one line and with no bracket inside. */
const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;

/** The little of the Markdown syntax tree the wikilink pass reads and writes. */
type TreeNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: TreeNode[];
};

/**
 * One text node, cut at its wikilinks. `[[Note|label]]` is shown as its label, and
 * `[[Note#Heading]]` as "Note › Heading"; the target keeps the `#` for the resolver.
 */
function cutWikilinks(text: string): TreeNode[] {
  const nodes: TreeNode[] = [];
  let from = 0;
  for (const match of text.matchAll(WIKI)) {
    const [whole, bang, inner = ""] = match;
    const bar = inner.indexOf("|");
    const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    if (target === "") {
      continue;
    }
    const label = bar < 0 ? "" : inner.slice(bar + 1).trim();
    if (match.index > from) {
      nodes.push({ type: "text", value: text.slice(from, match.index) });
    }
    const url = encodeURIComponent(target);
    nodes.push(
      bang
        ? { type: "image", url: WIKIEMBED + url, alt: label || target }
        : {
            type: "link",
            url: WIKILINK + url,
            children: [
              { type: "text", value: label || target.replace(/^#/, "").replace(/#/g, " › ") },
            ],
          },
    );
    from = match.index + whole.length;
  }
  if (from === 0) {
    return [{ type: "text", value: text }];
  }
  if (from < text.length) {
    nodes.push({ type: "text", value: text.slice(from) });
  }
  return nodes;
}

/** Text inside a link is left alone: a link cannot hold another. Code is not text, so it is too. */
function rewriteWikilinks(node: TreeNode) {
  if (!node.children || node.type === "link" || node.type === "linkReference") {
    return;
  }
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value) {
      return cutWikilinks(child.value);
    }
    rewriteWikilinks(child);
    return [child];
  });
}

/** The remark plugin behind `wikilinks`: each one becomes a link or an image on a private scheme. */
function remarkWikilinks() {
  return rewriteWikilinks;
}

/** The target a private-scheme URL carries, or `undefined` for any other URL. */
function wikiTarget(url: string | undefined, scheme: string): string | undefined {
  return url?.startsWith(scheme) ? decode(url.slice(scheme.length)) : undefined;
}

function decode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/** A URL the document wrote that names something beside it: no scheme, no host, not a `#fragment`. */
function isRelative(url: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url) === false;
}

const OUTSIDE = "This points outside the documents.";

/**
 * A relative URL as the path it names, the way a browser resolves one against a page's address:
 * from the directory of `basePath`, or from the root when it starts with a slash. `undefined` when
 * the `..`s climb out of the root. A `#fragment` or `?query` rides along unchanged.
 */
function fromBase(basePath: string, url: string): string | undefined {
  const cut = url.search(/[?#]/);
  const path = cut < 0 ? url : url.slice(0, cut);
  const rooted = basePath.startsWith("/");
  const floor = rooted ? 1 : 0;
  const parts = path.startsWith("/") ? (rooted ? [""] : []) : basePath.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part !== "..") {
      parts.push(part);
    } else if (parts.length > floor) {
      parts.pop();
    } else {
      return undefined;
    }
  }
  return parts.join("/") + (cut < 0 ? "" : url.slice(cut));
}

/** What `Markdown` tells its links and images about where they go. */
const LinkContext = createContext<{
  resolveLink?: ResolveLink | undefined;
  basePath?: string | undefined;
}>({});

const PENDING = { pending: true } as const;

/**
 * The resolver's answer for one target. A plain answer is used as it comes, on every render, so a
 * resolver reading the app's own state is never behind it. A promise is waited for: pending until
 * it settles, broken if it rejects, and when the resolver changes the last answer stays up until
 * the new one arrives.
 */
function useResolution(target: string, kind: MarkdownLinkKind): MarkdownLinkResolution | undefined {
  const { resolveLink } = useContext(LinkContext);
  const answer = useMemo(() => resolveLink?.(target, { kind }), [resolveLink, target, kind]);
  const [settled, setSettled] = useState<{
    target: string;
    kind: MarkdownLinkKind;
    resolution: MarkdownLinkResolution | undefined;
  }>();

  useEffect(() => {
    if (isPromise(answer) === false) {
      return;
    }
    let current = true;
    const settle = (resolution: MarkdownLinkResolution | undefined) => {
      if (current) {
        setSettled({ target, kind, resolution });
      }
    };
    answer.then(settle, (error: unknown) =>
      settle({ broken: true, reason: error instanceof Error ? error.message : undefined }),
    );
    return () => {
      current = false;
    };
  }, [answer, target, kind]);

  if (isPromise(answer) === false) {
    return answer;
  }
  return settled?.target === target && settled.kind === kind ? settled.resolution : PENDING;
}

function isPromise<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === "function";
}

/**
 * A link that goes nowhere. It keeps the underline, dashed and in `negative`, so it still reads as
 * a link that was meant; `title` says why, and a screen reader is told in words.
 */
function BrokenLink({ reason, children }: { reason: string | undefined; children?: ReactNode }) {
  return (
    <span
      data-slot="markdown-broken-link"
      title={reason}
      className="font-medium text-negative underline decoration-dashed underline-offset-4"
    >
      {children}
      <span className="sr-only"> (broken link)</span>
    </span>
  );
}

function ResolvedLink({
  target,
  kind,
  children,
  ...anchor
}: ComponentPropsWithoutRef<"a"> & { target: string; kind: "link" | "wikilink" }) {
  const resolution = useResolution(target, kind);
  if (!resolution) {
    // No answer leaves a link as the document wrote it. A wikilink was written as a name, and a
    // name nobody resolved goes nowhere.
    return kind === "link" ? (
      <a {...anchor}>{children}</a>
    ) : (
      <BrokenLink reason={undefined}>{children}</BrokenLink>
    );
  }
  if ("render" in resolution) {
    return <>{resolution.render(children)}</>;
  }
  if ("href" in resolution) {
    return (
      <a {...anchor} href={resolution.href}>
        {children}
      </a>
    );
  }
  if ("broken" in resolution) {
    return <BrokenLink reason={resolution.reason}>{children}</BrokenLink>;
  }
  return (
    <span data-slot="markdown-pending-link" aria-busy="true" className="text-foreground/60">
      {children}
    </span>
  );
}

/** A link. One the app could know about goes to `resolveLink`; the rest are plain anchors. */
function DocumentLink({ href, children, ...anchor }: ComponentPropsWithoutRef<"a">) {
  const { resolveLink, basePath } = useContext(LinkContext);
  const name = wikiTarget(href, WIKILINK);
  if (name !== undefined) {
    return (
      <ResolvedLink {...anchor} target={name} kind="wikilink">
        {children}
      </ResolvedLink>
    );
  }
  if (!resolveLink || !href || isRelative(href) === false) {
    return (
      <a {...anchor} href={href}>
        {children}
      </a>
    );
  }
  const target = basePath === undefined ? decode(href) : fromBase(basePath, decode(href));
  if (target === undefined) {
    return <BrokenLink reason={OUTSIDE}>{children}</BrokenLink>;
  }
  return (
    <ResolvedLink {...anchor} href={href} target={target} kind="link">
      {children}
    </ResolvedLink>
  );
}

/**
 * Where an image is not: still being fetched, or not there at all. A dashed chip the height of a
 * line, carrying the alt text, so the paragraph around it keeps its shape either way.
 */
function ImagePlaceholder({
  label,
  missing,
  reason,
}: {
  label: string;
  missing: boolean;
  reason?: string | undefined;
}) {
  const Icon = missing ? ImageOff : ImageIcon;
  return (
    <span
      data-slot={missing ? "markdown-missing-image" : "markdown-pending-image"}
      title={reason}
      {...(missing ? {} : { "aria-busy": "true" as const })}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-0.5 align-middle text-xs",
        missing ? "border-negative/40 text-negative" : "border-foreground/15 text-foreground/60",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {missing ? (label ? `Missing image: ${label}` : "Missing image") : label || "Image"}
    </span>
  );
}

function ResolvedImage({
  target,
  kind,
  src,
  alt,
  title,
}: {
  target: string;
  kind: "image" | "embed";
  src?: string | undefined;
  alt: string;
  title: string | undefined;
}) {
  const resolution = useResolution(target, kind);
  if (!resolution) {
    return src ? (
      <img src={src} alt={alt} title={title} />
    ) : (
      <ImagePlaceholder label={alt} missing />
    );
  }
  if ("render" in resolution) {
    return <>{resolution.render(alt)}</>;
  }
  if ("href" in resolution) {
    return <img src={resolution.href} alt={alt} title={title} />;
  }
  if ("broken" in resolution) {
    return <ImagePlaceholder label={alt} missing reason={resolution.reason} />;
  }
  return <ImagePlaceholder label={alt} missing={false} />;
}

/**
 * An image, resolved as a link is. Without a resolver it only drops a blanked address: the URL
 * policy turns an unsafe `src` into `""`, and an image with an empty `src` asks the browser for
 * the page it is on. Its look is the root's.
 */
function DocumentImage({ src, alt = "", title }: ComponentPropsWithoutRef<"img">) {
  const { resolveLink, basePath } = useContext(LinkContext);
  const name = wikiTarget(src, WIKIEMBED);
  if (name !== undefined) {
    return <ResolvedImage target={name} kind="embed" alt={alt} title={title} />;
  }
  if (!resolveLink || !src || isRelative(src) === false) {
    return <img src={src || undefined} alt={alt} title={title} />;
  }
  const target = basePath === undefined ? decode(src) : fromBase(basePath, decode(src));
  if (target === undefined) {
    return <ImagePlaceholder label={alt} missing reason={OUTSIDE} />;
  }
  return <ResolvedImage target={target} kind="image" src={src} alt={alt} title={title} />;
}

/**
 * The element map: what each piece of Markdown is drawn as.
 *
 * Declared once, at the top level, rather than built inside the component. react-markdown mounts
 * whatever it is handed as a component, so a map rebuilt on every render is a new set of component
 * types every render, and the whole document remounts on each keystroke of an editor beside it.
 *
 * Emphasis, strong text and strikethrough are absent because the browser's own are right; links
 * and images wear no class, because the root styles both (see {@link DOCUMENT}).
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
    <blockquote className={cn(FLOW, "m-0 border-foreground/10 border-l-2 pl-4 text-foreground/60")}>
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
  // `node` is react-markdown's, not the anchor's. The rest is kept: a footnote's reference and its
  // way back are links whose ids and labels remark-gfm wrote.
  a: ({ node: _node, ...anchor }) => <DocumentLink {...anchor} />,
  img: ({ src, alt, title }) => <DocumentImage src={src} alt={alt} title={title} />,
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
  emptySlot?: SlotNode;
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
  /**
   * Reads `[[Note]]`, `[[Note|label]]`, `[[Note#Heading]]` and `![[image.png]]`. Off by default:
   * in plain Markdown two brackets are text. Each one is a name, so each goes to `resolveLink`,
   * as a `wikilink` or an `embed`; one that gets no answer is drawn broken.
   */
  wikilinks?: boolean | undefined;
  /**
   * Where a link or an image goes, for the app whose documents point at each other. Called with
   * each wikilink and each relative URL — never with a web address or a `#fragment` — and answers
   * `{ href }`, `{ render }` for the router's own link, `{ pending: true }` or
   * `{ broken: true, reason }`. Nothing at all leaves the link as the document wrote it.
   *
   * It may return a promise instead; the link is drawn pending until it settles. Then keep it the
   * same function between renders (`useCallback`), since every new one is asked again.
   */
  resolveLink?: ResolveLink | undefined;
  /**
   * The path of the document shown, as a page's address is to its links: `guide/intro.md`, or
   * `guide/` for a directory. With it a relative URL reaches `resolveLink` as a whole path
   * (`../api.md` as `api.md`), and one that climbs out of the root is drawn broken. Without it
   * `resolveLink` gets the URL as written. Wikilinks are names, and are never resolved against it.
   */
  basePath?: string | undefined;
  /** The document's root: its width, its margin. */
  className?: string | undefined;
};

/**
 * A Markdown string, rendered: the reader of a note, a README, a skill, a model's answer.
 *
 * It is the element map, and the link handling every app with a set of documents needs the same
 * way. Every element is drawn from the theme's tokens and from
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
 * **Links between documents** are `wikilinks`, `resolveLink` and `basePath`. What a name points at
 * is the app's to say, so the resolver is its own; what a link that is still being looked up, or
 * that points at nothing, looks like is drawn here, so it is the same in every app.
 *
 * There is no syntax highlighting, which `CodeBlock` does not have either.
 */
export function Markdown({
  content,
  emptySlot,
  headingId,
  components,
  remarkPlugins,
  urlTransform,
  wikilinks = false,
  resolveLink,
  basePath,
  className,
}: MarkdownProps) {
  const elements = useMemo(
    () => (components ? { ...ELEMENTS, ...components } : ELEMENTS),
    [components],
  );
  const plugins = useMemo(
    () => [...GFM, ...(wikilinks ? [remarkWikilinks] : []), ...(remarkPlugins ?? [])],
    [remarkPlugins, wikilinks],
  );
  // The private schemes are let past the policy only while the plugin that writes them is on, so
  // a document cannot reach them by spelling one out.
  const policy = useMemo<UrlTransform>(() => {
    const given = urlTransform ?? defaultUrlTransform;
    if (!wikilinks) {
      return given;
    }
    return (url, key, node) =>
      url.startsWith(WIKILINK) || url.startsWith(WIKIEMBED) ? url : given(url, key, node);
  }, [urlTransform, wikilinks]);
  const links = useMemo(() => ({ resolveLink, basePath }), [resolveLink, basePath]);

  if (content.trim() === "") {
    // Rule 5 — an absent slot draws nothing, and that includes the root.
    return emptySlot ? (
      <div data-slot="markdown" className={cn(DOCUMENT, className)}>
        {emptySlot}
      </div>
    ) : null;
  }

  return (
    <div data-slot="markdown" className={cn(DOCUMENT, className)}>
      <HeadingIdContext.Provider value={headingId}>
        <LinkContext.Provider value={links}>
          <ReactMarkdown remarkPlugins={plugins} urlTransform={policy} components={elements}>
            {content}
          </ReactMarkdown>
        </LinkContext.Provider>
      </HeadingIdContext.Provider>
    </div>
  );
}
