import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ActionButton } from "@/components/action-button";
import { FileText, Folder as FolderIcon, Tag } from "@/components/app-icons";
import { DeleteDoc, NewNote, UploadDocs } from "@/components/doc-actions";
import { DocEditor } from "@/components/doc-editor";
import { McpOffHint } from "@/components/folder-actions";
import { StickyHeaderContentFooter } from "@/components/header-content-footer";
import { MarkdownPreview } from "@/components/markdown-preview";
import { PageHeader } from "@/components/page-header";
import { QueryError, QueryState } from "@/components/query-state";
import { SidebarLayout } from "@/components/split-layout";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, Copy, Pencil, Plus, Search } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { SegmentedButton, SegmentedGroup } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import type { DocSummary, Folder, SearchHit } from "@/lib/api";
import { inFolder, setLastFolder, withinFolder } from "@/lib/folders";
import { formatAgo, formatBytes, formatCount } from "@/lib/format";
import { listValue, slug, splitFrontmatter } from "@/lib/markdown";
import { useDoc, useDocs, useFolders, useSearch, useStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";

const route = getRouteApi("/f/$folder");

/** `notes/ideas/a.md` → `notes/ideas`: where a new note goes beside the open one. */
const dirOf = (path: string | undefined) =>
  path ? withinFolder(path).split("/").slice(0, -1).join("/") : "";

/** A tag filter takes the nested tags under it too: `project` also matches `project/alpha`. */
const hasTag = (tags: readonly string[], tag: string) =>
  tags.some((each) => each === tag || each.startsWith(`${tag}/`));

/**
 * One folder: its files, and the selected one rendered beside the list. `?doc=` is relative to the
 * folder, so a link reads the way the folder does on disk; the server is asked root-relative paths.
 */
export function DocsPage() {
  const { folder } = route.useParams();
  const folders = useFolders();
  const current = folders.data?.folders.find((each) => each.name === folder);

  useEffect(() => {
    if (current) setLastFolder(current.name);
  }, [current]);

  if (folders.data && !current) return <NoSuchFolder name={folder} />;
  return <FolderDocs folder={folder} title={current?.title ?? folder} info={current} />;
}

function FolderDocs({
  folder,
  title,
  info,
}: {
  folder: string;
  title: string;
  info: Folder | undefined;
}) {
  const { doc: selected } = route.useSearch();
  const docs = useDocs(folder);
  const known = useMemo(() => new Set(docs.data?.map((doc) => doc.path)), [docs.data]);
  const path = selected ? inFolder(folder, selected) : undefined;
  const summary = docs.data?.find((doc) => doc.path === path);

  useEffect(() => {
    document.title = summary ? `${summary.title} · ${title} · ragdown` : `${title} · ragdown`;
  }, [summary, title]);

  return (
    <SidebarLayout
      className="md:h-full"
      sidebarPosition="start"
      sidebarWidth="md"
      stackBelow="md"
      divider="line"
      sidebar={<DocList folder={folder} title={title} info={info} docs={docs} selected={path} />}
      content={
        path ? (
          <DocPreview key={path} folder={folder} path={path} summary={summary} known={known} />
        ) : (
          <NothingSelected folder={folder} title={title} count={docs.data?.length} />
        )
      }
    />
  );
}

/** Typing into search asks the server once the typing stops, not once per key. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

type Mode = "filter" | "search";

/**
 * The folder's files. Filter narrows the list by title, path, tag and alias as you type, on this
 * side; search asks the index, so it finds what a note says rather than what it is called.
 */
function DocList({
  folder,
  title,
  info,
  docs,
  selected,
}: {
  folder: string;
  title: string;
  info: Folder | undefined;
  docs: ReturnType<typeof useDocs>;
  selected: string | undefined;
}) {
  const { tag } = route.useSearch();
  const [mode, setMode] = useState<Mode>("filter");
  const [text, setText] = useState("");
  const query = useDebounced(mode === "search" ? text.trim() : "", 250);
  const search = useSearch(folder, query, tag);
  const navigate = useNavigate();
  const writable = useWritable();

  const tags = useMemo(
    () => [...new Set(docs.data?.flatMap((doc) => doc.tags))].sort(),
    [docs.data],
  );
  const rows = useMemo(() => {
    const words = mode === "filter" ? text.toLowerCase().split(/\s+/).filter(Boolean) : [];
    return (docs.data ?? []).filter((doc) => {
      if (tag && !hasTag(doc.tags, tag)) return false;
      const haystack =
        `${doc.title} ${withinFolder(doc.path)} ${doc.aliases.join(" ")} ${doc.tags.join(" ")}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [docs.data, text, tag, mode]);
  const chunks = docs.data?.reduce((sum, doc) => sum + doc.chunks, 0) ?? 0;
  const searching = mode === "search" && query !== "";

  return (
    <StickyHeaderContentFooter
      header={
        <PageHeader
          level={2}
          // A narrow pane: the folder's name keeps 10rem, not the page header's 16, before its two
          // buttons drop to a line of their own.
          className="[&_[data-slot=page-header-titles]]:basis-40"
          title={title}
          icon={<FolderIcon className="size-4 text-muted-foreground" aria-hidden />}
          action={
            writable ? (
              <div className="flex shrink-0 items-center gap-1">
                <NewNote folder={folder} title={title} dir={dirOf(selected)} />
                <UploadDocs folder={folder} title={title} />
              </div>
            ) : undefined
          }
          loading={docs.isPending}
          description={
            docs.data ? (
              <>
                {formatCount(docs.data.length, "file")} · {formatCount(chunks, "chunk")}
                {info ? (info.mcp ? " · on MCP" : " · human-only") : null}
              </>
            ) : undefined
          }
          content={
            <div className="flex flex-col gap-2">
              <McpOffHint />
              <div className="flex items-center gap-2">
                <SegmentedGroup
                  aria-label="Find by"
                  variant="framed"
                  value={mode}
                  onValueChange={(next) => setMode(next as Mode)}
                >
                  <SegmentedButton value="filter">Filter</SegmentedButton>
                  <SegmentedButton value="search">Search</SegmentedButton>
                </SegmentedGroup>
                <TagMenu folder={folder} tags={tags} active={tag} />
              </div>
              <div className="relative">
                <Search
                  className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  type="search"
                  aria-label={mode === "search" ? `Search ${title}` : "Filter documents"}
                  placeholder={
                    mode === "search" ? "Search what the notes say" : "Filter by title, path or tag"
                  }
                  className="pl-8"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </div>
              {tag ? (
                <div>
                  <Badge
                    variant="secondary"
                    removeLabel={`Clear the tag filter #${tag}`}
                    onRemove={() =>
                      void navigate({
                        to: "/f/$folder",
                        params: { folder },
                        search: ({ tag: _, ...rest }) => rest,
                      })
                    }
                  >
                    #{tag}
                  </Badge>
                </div>
              ) : null}
            </div>
          }
        />
      }
      contentClassName="px-2 pb-4"
      content={
        searching ? (
          <SearchResults folder={folder} search={search} selected={selected} />
        ) : (
          <div className="flex flex-col gap-1">
            <QueryState
              query={docs}
              what="the documents"
              count={rows.length}
              empty={
                <p className="px-2 py-6 text-center text-muted-foreground text-sm">
                  {text && mode === "filter"
                    ? "No document matches that filter."
                    : tag
                      ? `No document here is tagged #${tag}.`
                      : mode === "search"
                        ? "Type to search this folder."
                        : "Nothing is indexed here yet. Markdown files in this folder show up once they are."}
                </p>
              }
            />
            {/* `ItemGroup` no longer claims `role="list"` itself; these rows are list items, so it does here. */}
            <ItemGroup role="list">
              {rows.map((doc) => (
                <DocRow key={doc.path} folder={folder} doc={doc} active={doc.path === selected} />
              ))}
            </ItemGroup>
          </div>
        )
      }
    />
  );
}

/** Pick a tag to narrow the list (and search) to it. Kept in the URL, so a preview's tags link here. */
function TagMenu({
  folder,
  tags,
  active,
}: {
  folder: string;
  tags: string[];
  active: string | undefined;
}) {
  if (tags.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="outline" size="sm" className="ml-auto">
          <Tag aria-hidden /> {active ? `#${active}` : "Tags"}
        </Button>
      </MenuTrigger>
      <MenuContent align="end" className="max-h-80">
        {active ? (
          <MenuItem
            label="All tags"
            link={
              <Link to="/f/$folder" params={{ folder }} search={({ tag: _, ...rest }) => rest} />
            }
          />
        ) : null}
        {tags.map((tag) => (
          <MenuItem
            key={tag}
            label={`#${tag}`}
            trailing={tag === active ? "✓" : undefined}
            link={
              <Link to="/f/$folder" params={{ folder }} search={(prev) => ({ ...prev, tag })} />
            }
          />
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Sections the index found, best first; each opens its note at the heading it came from. */
function SearchResults({
  folder,
  search,
  selected,
}: {
  folder: string;
  search: ReturnType<typeof useSearch>;
  selected: string | undefined;
}) {
  const hits = search.data ?? [];
  return (
    <div className="flex flex-col gap-1" aria-busy={search.isFetching}>
      <QueryState
        query={search}
        what="the search"
        count={hits.length}
        empty={
          <p className="px-2 py-6 text-center text-muted-foreground text-sm">
            Nothing in this folder matches that.
          </p>
        }
      />
      <ItemGroup role="list">
        {hits.map((hit) => (
          <HitRow
            key={`${hit.path}:${hit.start_line}`}
            folder={folder}
            hit={hit}
            active={hit.path === selected}
          />
        ))}
      </ItemGroup>
    </div>
  );
}

function HitRow({ folder, hit, active }: { folder: string; hit: SearchHit; active: boolean }) {
  const anchor = hit.heading ? slug(hit.heading.split(" › ").pop() ?? hit.heading) : "";
  return (
    <Item
      asChild
      size="sm"
      role="listitem"
      className={cn("px-3 py-2", active && "bg-accent text-accent-foreground [a]:hover:bg-accent")}
    >
      <Link
        to="/f/$folder"
        params={{ folder }}
        search={(prev) => ({ ...prev, doc: withinFolder(hit.path) })}
        {...(anchor ? { hash: anchor } : {})}
      >
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="w-full truncate">{hit.title}</ItemTitle>
          {hit.heading ? (
            <ItemDescription className="truncate text-xs">{hit.heading}</ItemDescription>
          ) : null}
          <ItemDescription className="line-clamp-2 text-xs">{hit.text}</ItemDescription>
        </ItemContent>
      </Link>
    </Item>
  );
}

function DocRow({ folder, doc, active }: { folder: string; doc: DocSummary; active: boolean }) {
  const relative = withinFolder(doc.path);
  const dir = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/") + 1) : "";
  const file = relative.slice(dir.length);
  return (
    <Item
      asChild
      size="sm"
      role="listitem"
      className={cn("px-3 py-2", active && "bg-accent text-accent-foreground [a]:hover:bg-accent")}
    >
      <Link
        to="/f/$folder"
        params={{ folder }}
        search={(prev) => ({ ...prev, doc: relative })}
        aria-current={active ? "page" : undefined}
      >
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="w-full truncate">{doc.title}</ItemTitle>
          <ItemDescription className="truncate text-xs">
            <span className="text-muted-foreground/70">{dir}</span>
            {file}
          </ItemDescription>
        </ItemContent>
      </Link>
    </Item>
  );
}

function NothingSelected({
  folder,
  title,
  count,
}: {
  folder: string;
  title: string;
  count: number | undefined;
}) {
  const writable = useWritable();
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 p-8 text-center">
      <FileText className="size-8 text-muted-foreground/60" aria-hidden />
      <p className="font-medium">Pick a document to preview it</p>
      <p className="max-w-sm text-muted-foreground text-sm">
        {count
          ? `${title} holds ${formatCount(count, "file")}. What you see here is read from disk, so it is current even while the index catches up.`
          : `The list fills in as the index syncs with ${title}.`}
      </p>
      {writable ? (
        <NewNote
          folder={folder}
          title={title}
          trigger={
            <Button variant="outline" size="sm" className="mt-2">
              <Plus aria-hidden /> New note
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

function NoSuchFolder({ name }: { name: string }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 p-8 text-center">
      <FolderIcon className="size-8 text-muted-foreground/60" aria-hidden />
      <p className="font-medium">There is no folder called {name}</p>
      <p className="max-w-sm text-muted-foreground text-sm">
        It may have been renamed or deleted.{" "}
        <Link to="/" className="underline underline-offset-4">
          Open another folder
        </Link>
        .
      </p>
    </div>
  );
}

function DocPreview({
  folder,
  path,
  summary,
  known,
}: {
  folder: string;
  path: string;
  summary: DocSummary | undefined;
  known: ReadonlySet<string>;
}) {
  const doc = useDoc(path);
  const writable = useWritable();
  const [editing, setEditing] = useState(false);
  const { edit } = route.useSearch();
  const navigate = useNavigate();

  // `?edit` (from New note) opens the editor once the note has loaded, then leaves the URL.
  useEffect(() => {
    if (!edit || !doc.data || !writable) return;
    setEditing(true);
    void navigate({
      to: "/f/$folder",
      params: { folder },
      search: ({ edit: _, ...rest }) => rest,
      replace: true,
    });
  }, [edit, doc.data, writable, folder, navigate]);
  const parsed = useMemo(() => splitFrontmatter(doc.data?.text ?? ""), [doc.data]);
  // The server's lists, which also carry inline `#tags`; the frontmatter's as a fallback.
  const frontmatter = (key: string) => {
    const field = parsed.fields.find(([name]) => name === key);
    return field ? listValue(field[1]) : [];
  };
  const tags = doc.data?.tags ?? summary?.tags ?? frontmatter("tags");
  const aliases = doc.data?.aliases ?? summary?.aliases ?? frontmatter("aliases");
  const otherFields = parsed.fields.filter(
    ([key]) => key !== "tags" && key !== "title" && key !== "aliases",
  );
  const hasBadges = tags.length > 0 || aliases.length > 0 || otherFields.length > 0;
  const title = summary?.title ?? path.split("/").pop() ?? path;

  if (editing && doc.data) {
    return (
      <DocEditor
        path={path}
        title={title}
        doc={doc.data}
        known={known}
        onClose={() => {
          setEditing(false);
          void doc.refetch();
        }}
      />
    );
  }

  return (
    <StickyHeaderContentFooter
      width="prose"
      header={
        <PageHeader
          title={title}
          breadcrumbs={
            <p className="break-all font-mono text-muted-foreground text-xs">
              {withinFolder(path)}
            </p>
          }
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
              {writable && doc.data ? (
                <ActionButton
                  variant="ghost"
                  size="icon-sm"
                  label="Edit"
                  onClick={() => setEditing(true)}
                >
                  <Pencil aria-hidden />
                </ActionButton>
              ) : null}
              {writable && summary ? <DeleteDoc path={path} /> : null}
            </>
          }
          content={
            hasBadges ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {aliases.length > 0 ? (
                  <span className="text-muted-foreground text-xs">
                    Also called {aliases.join(", ")}
                  </span>
                ) : null}
                {tags.map((tag) => (
                  // Not `<Badge asChild>`: cubeui's Badge hands its Slot a second, null child.
                  <Link
                    key={tag}
                    to="/f/$folder"
                    params={{ folder }}
                    search={(prev) => ({ ...prev, tag })}
                    aria-label={`Show documents tagged #${tag}`}
                    className={cn(badgeVariants({ variant: "secondary" }), "hover:underline")}
                  >
                    #{tag}
                  </Link>
                ))}
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

/** Upload, edit and delete are offered only once status says the server takes writes. */
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
