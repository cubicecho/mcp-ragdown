import { getRouteApi, Link } from "@tanstack/react-router";
import { Check, Copy, FileText, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ActionButton } from "@/components/action-button";
import { DeleteDoc, UploadDocs } from "@/components/doc-actions";
import { StickyHeaderContentFooter } from "@/components/header-content-footer";
import { MarkdownPreview } from "@/components/markdown-preview";
import { PageHeader } from "@/components/page-header";
import { QueryError, QueryState } from "@/components/query-state";
import { SidebarLayout } from "@/components/split-layout";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import type { DocSummary } from "@/lib/api";
import { formatAgo, formatBytes, formatCount } from "@/lib/format";
import { listValue, splitFrontmatter } from "@/lib/markdown";
import { useDoc, useDocs, useStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";

const route = getRouteApi("/");

/** The base view: every file the index holds, and the selected one rendered beside the list. */
export function DocsPage() {
  const { doc: selected } = route.useSearch();
  const docs = useDocs();
  const known = useMemo(() => new Set(docs.data?.map((doc) => doc.path)), [docs.data]);
  const summary = docs.data?.find((doc) => doc.path === selected);

  useEffect(() => {
    document.title = summary ? `${summary.title} · ragdown` : "ragdown";
  }, [summary]);

  return (
    <SidebarLayout
      className="md:h-full"
      sidebarPosition="start"
      sidebarWidth="md"
      stackBelow="md"
      divider="line"
      sidebar={<DocList docs={docs} selected={selected} />}
      content={
        selected ? (
          <DocPreview path={selected} summary={summary} known={known} />
        ) : (
          <NothingSelected count={docs.data?.length} />
        )
      }
    />
  );
}

function DocList({
  docs,
  selected,
}: {
  docs: ReturnType<typeof useDocs>;
  selected: string | undefined;
}) {
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return (docs.data ?? []).filter((doc) => {
      const haystack = `${doc.title} ${doc.path}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [docs.data, filter]);
  const chunks = docs.data?.reduce((sum, doc) => sum + doc.chunks, 0) ?? 0;
  const writable = useWritable();

  return (
    <StickyHeaderContentFooter
      header={
        <PageHeader
          level={2}
          title="Documents"
          action={writable ? <UploadDocs /> : undefined}
          loading={docs.isPending}
          description={
            docs.data
              ? `${formatCount(docs.data.length, "file")} · ${formatCount(chunks, "chunk")}`
              : undefined
          }
          content={
            <div className="relative">
              <Search
                className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                aria-label="Filter documents"
                placeholder="Filter by title or path"
                className="pl-8"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
          }
        />
      }
      contentClassName="px-2 pb-4"
      content={
        <div className="flex flex-col gap-1">
          <QueryState
            query={docs}
            what="the documents"
            count={rows.length}
            empty={
              <p className="px-2 py-6 text-center text-muted-foreground text-sm">
                {filter
                  ? "No document matches that filter."
                  : "Nothing is indexed yet. Markdown files in the docs folder show up here once they are."}
              </p>
            }
          />
          <ItemGroup>
            {rows.map((doc) => (
              <DocRow key={doc.path} doc={doc} active={doc.path === selected} />
            ))}
          </ItemGroup>
        </div>
      }
    />
  );
}

function DocRow({ doc, active }: { doc: DocSummary; active: boolean }) {
  const folder = doc.path.includes("/") ? doc.path.slice(0, doc.path.lastIndexOf("/") + 1) : "";
  const file = doc.path.slice(folder.length);
  return (
    <Item
      asChild
      size="sm"
      role="listitem"
      className={cn("px-3 py-2", active && "bg-accent text-accent-foreground [a]:hover:bg-accent")}
    >
      <Link to="/" search={{ doc: doc.path }} aria-current={active ? "page" : undefined}>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="w-full truncate">{doc.title}</ItemTitle>
          <ItemDescription className="truncate text-xs">
            <span className="text-muted-foreground/70">{folder}</span>
            {file}
          </ItemDescription>
        </ItemContent>
      </Link>
    </Item>
  );
}

function NothingSelected({ count }: { count: number | undefined }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 p-8 text-center">
      <FileText className="size-8 text-muted-foreground/60" aria-hidden />
      <p className="font-medium">Pick a document to preview it</p>
      <p className="max-w-sm text-muted-foreground text-sm">
        {count
          ? `The index holds ${formatCount(count, "file")}. What you see here is read from disk, so it is current even while the index catches up.`
          : "The list fills in as the index syncs with the docs folder."}
      </p>
    </div>
  );
}

function DocPreview({
  path,
  summary,
  known,
}: {
  path: string;
  summary: DocSummary | undefined;
  known: ReadonlySet<string>;
}) {
  const doc = useDoc(path);
  const writable = useWritable();
  const parsed = useMemo(() => splitFrontmatter(doc.data?.text ?? ""), [doc.data]);
  const tags = parsed.fields.find(([key]) => key === "tags");
  const otherFields = parsed.fields.filter(([key]) => key !== "tags" && key !== "title");

  return (
    <StickyHeaderContentFooter
      width="prose"
      header={
        <PageHeader
          title={summary?.title ?? path.split("/").pop()}
          breadcrumbs={<p className="break-all font-mono text-muted-foreground text-xs">{path}</p>}
          description={
            summary ? (
              <>
                {formatAgo(summary.mtime_ms)} · {formatBytes(summary.size)}
                {doc.data ? ` · ${formatCount(doc.data.total_lines, "line")}` : null} ·{" "}
                {formatCount(summary.chunks, "chunk")}
              </>
            ) : undefined
          }
          action={
            <>
              <CopyPath path={path} />
              {writable && summary ? <DeleteDoc path={path} /> : null}
            </>
          }
          content={
            tags || otherFields.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {tags
                  ? listValue(tags[1]).map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))
                  : null}
                {otherFields.map(([key, value]) => (
                  <Badge key={key} variant="outline" className="font-normal">
                    <span className="text-muted-foreground">{key}</span> {value}
                  </Badge>
                ))}
              </div>
            ) : undefined
          }
        />
      }
      contentClassName="pb-10"
      content={
        doc.isError ? (
          <QueryError error={doc.error} onRetry={() => void doc.refetch()} what={path} />
        ) : doc.isPending ? (
          <div className="flex flex-col gap-3" aria-busy>
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <MarkdownPreview content={parsed.body} path={path} known={known} />
        )
      }
    />
  );
}

/** Upload and delete are offered only once status says the server takes writes. */
function useWritable(): boolean {
  const status = useStatus();
  return status.data?.ready === true && status.data.read_only === false;
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <ActionButton
      variant="ghost"
      size="icon-sm"
      label={copied ? "Copied" : "Copy path"}
      onClick={() => {
        void navigator.clipboard?.writeText(path).then(() => setCopied(true));
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </ActionButton>
  );
}
