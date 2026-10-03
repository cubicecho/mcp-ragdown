import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type MouseEvent, type ReactNode, useMemo } from "react";
import { type Components, defaultUrlTransform } from "react-markdown";
import { Markdown } from "@/components/markdown";
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

const BROKEN =
  "cursor-help text-muted-foreground underline decoration-destructive decoration-dashed underline-offset-4";

/** The schemes the wikilink plugin writes pass through; everything else gets the default check. */
const urlTransform = (url: string) =>
  url.startsWith(WIKILINK) || url.startsWith(WIKIEMBED) ? url : defaultUrlTransform(url);

const decode = (url: string, scheme: string) => decodeURIComponent(url.slice(scheme.length));

/** Run after remark-gfm, which cubeui's `Markdown` always runs first. */
const PLUGINS = [remarkWikilinks];

/**
 * A note as a styled preview: cubeui's `Markdown` draws the elements, and the links and images are
 * this app's. Raw HTML is not rendered.
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
  // Held steady while the note is the same one: react-markdown mounts what it is handed as
  // component types, so a new map each render would remount every link and image.
  const components = useMemo<Components>(
    () => ({
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
          <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} {...props}>
            {children}
          </a>
        );
      },
      img: ({ node, src, alt, ...props }) => {
        if (typeof src !== "string" || !src) return <Missing label={alt} />;
        if (src.startsWith(WIKIEMBED)) {
          return <Embed from={path} target={decode(src, WIKIEMBED)} alt={alt} />;
        }
        if (/^(https?:|data:)/.test(src)) return <img src={src} alt={alt} {...props} />;
        const target = resolveDocLink(path, src);
        return target ? <FileImage path={target} alt={alt} /> : <Missing label={alt || src} />;
      },
    }),
    [path, known],
  );

  return (
    <Markdown
      content={content}
      empty={<p className="m-0 text-muted-foreground italic">This file is empty.</p>}
      headingId={slug}
      components={components}
      remarkPlugins={PLUGINS}
      urlTransform={urlTransform}
      className={className}
    />
  );
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
  return <Link {...docTarget(path, anchor)}>{label}</Link>;
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
    <a href={`#${encodeURIComponent(target)}`} onClick={go}>
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
  return <img src={file.url} alt={alt ?? ""} />;
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
