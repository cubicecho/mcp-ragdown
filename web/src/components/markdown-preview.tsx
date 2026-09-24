import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useToast } from "@/components/ui/toast";
import { ApiError, type Resolved } from "@/lib/api";
import { folderOf, withinFolder } from "@/lib/folders";
import {
  isImagePath,
  isMarkdownPath,
  remarkWikilinks,
  resolveDocLink,
  slug,
  WIKIEMBED,
  WIKILINK,
} from "@/lib/markdown";
import { fileQuery, resolveQuery, useFileUrl, useResolve } from "@/lib/queries";
import { cn } from "@/lib/utils";

const LINK = "text-primary underline underline-offset-4";
const BROKEN =
  "cursor-help text-muted-foreground underline decoration-destructive decoration-dashed underline-offset-4";

/** The schemes the wikilink plugin writes pass through; everything else gets the default check. */
const urlTransform = (url: string) =>
  url.startsWith(WIKILINK) || url.startsWith(WIKIEMBED) ? url : defaultUrlTransform(url);

const decode = (url: string, scheme: string) => decodeURIComponent(url.slice(scheme.length));

/**
 * Markdown as a styled preview, after mcp-skills-manager's: a class per element rather than the
 * typography plugin, so it reads in both themes. Raw HTML is not rendered.
 *
 * `[[wikilinks]]` are asked of the server, which resolves them the way Obsidian does, within the
 * note's folder; a link to nothing is drawn as broken. A relative link to an indexed file opens it
 * here. Images — `![[image.png]]` and relative `![](img.png)` — are fetched with the token and
 * shown from blob URLs, since an `<img src>` cannot carry the header.
 */
export function MarkdownPreview({
  content,
  path,
  known,
  className,
}: {
  content: string;
  /** The file being shown, root-relative, which relative links and wikilinks resolve against. */
  path: string;
  /** Root-relative paths the index holds; a link to one of them stays in the app. */
  known: ReadonlySet<string>;
  className?: string;
}) {
  if (!content.trim()) {
    return <p className="text-muted-foreground text-sm italic">This file is empty.</p>;
  }
  return (
    <div className={cn("min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere]", className)}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkWikilinks]}
        urlTransform={urlTransform}
        components={{
          h1: ({ node, ...props }) => (
            <h1
              id={slug(textOf(node))}
              className="mt-8 mb-3 scroll-mt-4 font-semibold text-2xl first:mt-0"
              {...props}
            />
          ),
          h2: ({ node, ...props }) => (
            <h2
              id={slug(textOf(node))}
              className="mt-8 mb-2 scroll-mt-4 border-b pb-1 font-semibold text-xl first:mt-0"
              {...props}
            />
          ),
          h3: ({ node, ...props }) => (
            <h3
              id={slug(textOf(node))}
              className="mt-6 mb-2 scroll-mt-4 font-semibold text-lg first:mt-0"
              {...props}
            />
          ),
          h4: ({ node, ...props }) => (
            <h4
              id={slug(textOf(node))}
              className="mt-4 mb-2 scroll-mt-4 font-semibold first:mt-0"
              {...props}
            />
          ),
          p: ({ node, ...props }) => <p className="my-3 first:mt-0" {...props} />,
          ul: ({ node, ...props }) => <ul className="my-3 list-disc pl-6" {...props} />,
          ol: ({ node, ...props }) => <ol className="my-3 list-decimal pl-6" {...props} />,
          li: ({ node, ...props }) => <li className="my-1" {...props} />,
          a: ({ node, href = "", children, ...props }) => {
            if (href.startsWith(WIKILINK)) {
              return <WikiLink from={path} target={decode(href, WIKILINK)} label={children} />;
            }
            const target = resolveDocLink(path, href);
            if (target !== undefined && known.has(target)) {
              return <DocLink path={target} label={children} />;
            }
            if (target !== undefined && !isMarkdownPath(target)) {
              return <AttachmentLink path={target} label={children} />;
            }
            const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
            return (
              <a
                href={href}
                className={LINK}
                {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                {...props}
              >
                {children}
              </a>
            );
          },
          img: ({ node, src, alt, ...props }) => {
            if (typeof src !== "string") return <Missing label={alt} />;
            if (src.startsWith(WIKIEMBED)) {
              return <Embed from={path} target={decode(src, WIKIEMBED)} alt={alt} />;
            }
            if (/^(https?:|data:)/.test(src)) {
              return <img src={src} alt={alt} className="my-3 max-w-full rounded-md" {...props} />;
            }
            const target = resolveDocLink(path, src);
            return target ? <FileImage path={target} alt={alt} /> : <Missing label={alt || src} />;
          },
          blockquote: ({ node, ...props }) => (
            <blockquote className="my-3 border-l-2 pl-4 text-muted-foreground" {...props} />
          ),
          code: ({ node, className: codeClass, ...props }) =>
            /language-/.test(codeClass ?? "") ? (
              <code className={cn("font-mono text-[0.85em]", codeClass)} {...props} />
            ) : (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]" {...props} />
            ),
          pre: ({ node, ...props }) => (
            <pre
              className="my-3 overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs [overflow-wrap:normal]"
              {...props}
            />
          ),
          table: ({ node, ...props }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm" {...props} />
            </div>
          ),
          th: ({ node, ...props }) => (
            <th className="border px-3 py-1.5 text-left font-medium" {...props} />
          ),
          td: ({ node, ...props }) => <td className="border px-3 py-1.5" {...props} />,
          hr: ({ node, ...props }) => <hr className="my-6" {...props} />,
          input: ({ node, ...props }) => <input className="mr-1.5 align-middle" {...props} />,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

type HastNode = { type: string; value?: string; children?: HastNode[] };

/** A heading's text, for its anchor. */
function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/** The route of a root-relative note, with the heading a `#Heading` link aims at. */
function docTarget(path: string, anchor?: string) {
  return {
    to: "/f/$folder" as const,
    params: { folder: folderOf(path) },
    search: { doc: withinFolder(path) },
    ...(anchor && !anchor.startsWith("^") ? { hash: slug(anchor) } : {}),
  };
}

function DocLink({ path, anchor, label }: { path: string; anchor?: string; label: ReactNode }) {
  return (
    <Link {...docTarget(path, anchor)} className={LINK}>
      {label}
    </Link>
  );
}

const is404 = (error: unknown) => error instanceof ApiError && error.status === 404;

/**
 * A `[[wikilink]]`. Resolved as it renders, so a broken one is drawn as broken before anyone
 * clicks it; a resolved note is a real link, and an attachment opens from a blob.
 */
function WikiLink({ from, target, label }: { from: string; target: string; label: ReactNode }) {
  const resolved = useResolve(from, target);
  const client = useQueryClient();
  const navigate = useNavigate();
  const open = useOpenAttachment();
  const toast = useToast();

  if (resolved.isError && is404(resolved.error)) {
    return (
      <span className={BROKEN} title={`Nothing in this folder matches [[${target}]]`}>
        {label}
        <span className="sr-only"> (broken link)</span>
      </span>
    );
  }
  if (resolved.data) {
    return isMarkdownPath(resolved.data.path) ? (
      <DocLink path={resolved.data.path} anchor={resolved.data.anchor} label={label} />
    ) : (
      <AttachmentLink path={resolved.data.path} label={label} />
    );
  }

  // Still resolving, or the server failed: resolve on the click instead.
  const go = async (event: MouseEvent) => {
    event.preventDefault();
    let found: Resolved;
    try {
      found = await client.fetchQuery(resolveQuery(from, target));
    } catch (error) {
      toast(is404(error) ? `Nothing matches [[${target}]]` : `Could not follow [[${target}]]`);
      return;
    }
    if (isMarkdownPath(found.path)) void navigate(docTarget(found.path, found.anchor));
    else void open(found.path);
  };
  return (
    <a href={`#${encodeURIComponent(target)}`} className={LINK} onClick={go}>
      {label}
    </a>
  );
}

/** A link to a non-Markdown file in a folder: a PDF, audio, an image. */
function AttachmentLink({ path, label }: { path: string; label: ReactNode }) {
  const open = useOpenAttachment();
  return (
    <a
      href={`#${encodeURIComponent(path)}`}
      className={LINK}
      title={path}
      onClick={(event) => {
        event.preventDefault();
        void open(path);
      }}
    >
      {label}
    </a>
  );
}

/** Types a browser tab shows without running anything. SVG and HTML are downloaded instead. */
const INLINE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain",
  csv: "text/plain",
};

/**
 * Open a file from a folder. It has to be fetched with the token, so it opens from a blob URL:
 * a tab is opened first, inside the click, so no popup blocker stops it, and pointed at the blob
 * once it lands. A blob URL is this page's origin, so anything that could run script there — SVG,
 * HTML, whatever the browser might sniff — is saved as a download rather than shown.
 */
function useOpenAttachment() {
  const client = useQueryClient();
  const toast = useToast();
  return async (path: string) => {
    const name = path.split("/").pop() ?? "file";
    const type = INLINE[name.split(".").pop()?.toLowerCase() ?? ""];
    const tab = type ? window.open("", "_blank") : null;
    if (tab) tab.opener = null;
    try {
      const blob = await client.fetchQuery(fileQuery(path));
      const url = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
      if (tab) {
        tab.location.href = url;
      } else {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.click();
      }
      // Long enough for the tab or the download to have read it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      tab?.close();
      toast(`Could not open ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** `![[target]]`: an image is drawn, a note or another file is a link to it. */
function Embed({ from, target, alt }: { from: string; target: string; alt: string | undefined }) {
  const resolved = useResolve(from, target);
  if (resolved.isError) {
    return is404(resolved.error) ? (
      <span className={BROKEN} title={`Nothing in this folder matches ![[${target}]]`}>
        {alt || target}
        <span className="sr-only"> (broken embed)</span>
      </span>
    ) : (
      <Missing label={alt || target} />
    );
  }
  if (!resolved.data) return <Missing label={alt || target} busy />;
  const { path, anchor } = resolved.data;
  if (isImagePath(path)) return <FileImage path={path} alt={alt} />;
  if (isMarkdownPath(path)) return <DocLink path={path} anchor={anchor} label={alt || target} />;
  return <AttachmentLink path={path} label={alt || target} />;
}

/** An image from a folder, shown from a blob URL. */
function FileImage({ path, alt }: { path: string; alt: string | undefined }) {
  const file = useFileUrl(path);
  if (file.isError) return <Missing label={alt || path} broken />;
  if (!file.url) return <Missing label={alt || path} busy />;
  return <img src={file.url} alt={alt ?? ""} className="my-3 max-w-full rounded-md" />;
}

/** What stands in for an image that is loading or cannot be shown. */
function Missing({
  label,
  busy,
  broken,
}: {
  label: string | undefined;
  busy?: boolean;
  broken?: boolean;
}) {
  return (
    <span
      className={cn(
        "rounded border border-dashed px-1.5 py-0.5 text-muted-foreground text-xs",
        broken && "border-destructive/60",
      )}
      aria-busy={busy || undefined}
    >
      {broken ? "missing image" : "image"}: {label}
    </span>
  );
}
