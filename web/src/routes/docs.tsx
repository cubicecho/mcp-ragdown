import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ActionButton } from "@/components/action-button";
import { FilePlus } from "@/components/app-icons";
import { Backlinks } from "@/components/backlinks";
import { DeleteDoc, NewNote, RenameDoc, UploadDocs } from "@/components/doc-actions";
import { DocEditor } from "@/components/doc-editor";
import { FileTree } from "@/components/file-tree";
import { McpOffHint } from "@/components/folder-actions";
import { StickyHeaderContentFooter } from "@/components/header-content-footer";
import { MarkdownPreview } from "@/components/markdown-preview";
import { EmptyState } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { QueryError, QueryState } from "@/components/query-state";
import { SidebarLayout } from "@/components/split-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  ArrowDownWideNarrow,
  Download,
  FileText,
  Folder as FolderIcon,
  Pencil,
  Plus,
  Search,
  Tag,
} from "@/components/ui/icons";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedButton, SegmentedGroup } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { type DocSummary, type Folder, getFile, type SearchHit } from "@/lib/api";
import { inFolder, setLastFolder, withinFolder } from "@/lib/folders";
import { formatAgo, formatBytes, formatCount } from "@/lib/format";
import { listValue, slug, splitFrontmatter } from "@/lib/markdown";
import { useDoc, useDocs, useFolders, useSearch, useWritable } from "@/lib/queries";
import type { TreeEntry } from "@/lib/tree";
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
          <DocPreview
            key={path}
            folder={folder}
            path={path}
            summary={summary}
            docs={docs.data}
            known={known}
          />
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

/** A note as the file tree lists it: its path within the folder, and the note. */
type NoteEntry = TreeEntry & { doc: DocSummary };

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
  const { tag, sort } = route.useSearch();
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
    const matching = (docs.data ?? []).filter((doc) => {
      if (tag && !hasTag(doc.tags, tag)) return false;
      const haystack =
        `${doc.title} ${withinFolder(doc.path)} ${doc.aliases.join(" ")} ${doc.tags.join(" ")}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    return sort === "recent" ? matching.sort((a, b) => b.mtime_ms - a.mtime_ms) : matching;
  }, [docs.data, text, tag, mode, sort]);
  const entries = useMemo(
    () => rows.map((doc): NoteEntry => ({ path: withinFolder(doc.path), type: "file", doc })),
    [rows],
  );
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
                <div className="ml-auto flex items-center gap-1">
                  <SortMenu folder={folder} active={sort} />
                  <TagMenu folder={folder} tags={tags} active={tag} />
                </div>
              </div>
              <SearchInput
                label={mode === "search" ? `Search ${title}` : "Filter documents"}
                placeholder={
                  mode === "search" ? "Search what the notes say" : "Filter by title, path or tag"
                }
                value={text}
                onChangeText={setText}
              />
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
                <EmptyState
                  icon={FileText}
                  title={
                    text && mode === "filter"
                      ? "No document matches that filter."
                      : tag
                        ? `No document here is tagged #${tag}.`
                        : mode === "search"
                          ? "Type to search this folder."
                          : "Nothing is indexed here yet."
                  }
                  description={
                    text || tag || mode === "search"
                      ? undefined
                      : "Markdown files in this folder show up once they are."
                  }
                />
              }
            />
            {sort === "recent" ? (
              // Newest first has no folders to nest under, so it stays a flat list.
              // `ItemGroup` no longer claims `role="list"` itself; these rows are list items, so it does here.
              <ItemGroup role="list">
                {rows.map((doc) => (
                  <DocRow key={doc.path} folder={folder} doc={doc} active={doc.path === selected} />
                ))}
              </ItemGroup>
            ) : (
              <FileTree
                label="Notes"
                entries={entries}
                selected={selected ? withinFolder(selected) : undefined}
                linkSlot={(node) => (
                  <Link
                    to="/f/$folder"
                    params={{ folder }}
                    search={(prev) => ({ ...prev, doc: node.path })}
                    title={node.entry?.doc.title}
                  />
                )}
                meta={(node) => (node.entry?.doc.superseded_by.length ? <Superseded /> : null)}
                actionSlot={(node) =>
                  writable && node.type === "dir" ? (
                    <NewNote
                      folder={folder}
                      title={title}
                      dir={node.path}
                      trigger={
                        <ActionButton
                          variant="ghost"
                          size="icon-xs"
                          label={`New note in ${node.path}`}
                        >
                          <FilePlus aria-hidden />
                        </ActionButton>
                      }
                    />
                  ) : null
                }
              />
            )}
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
        <Button variant="outline" size="sm">
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

/** By path, as the folder reads on disk, or the most recently changed first. Kept in the URL. */
function SortMenu({ folder, active }: { folder: string; active: "recent" | undefined }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        {/* Icon only: the pane is narrow, and Filter, Search and Tags already share the row. */}
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={active === "recent" ? "Sorted by recently changed" : "Sorted by path"}
          title={active === "recent" ? "Sorted by recently changed" : "Sorted by path"}
        >
          <ArrowDownWideNarrow aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem
          label="By path"
          trailing={active === undefined ? "✓" : undefined}
          link={
            <Link to="/f/$folder" params={{ folder }} search={({ sort: _, ...rest }) => rest} />
          }
        />
        <MenuItem
          label="Recently changed"
          trailing={active === "recent" ? "✓" : undefined}
          link={
            <Link
              to="/f/$folder"
              params={{ folder }}
              search={(prev) => ({ ...prev, sort: "recent" as const })}
            />
          }
        />
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
        empty={<EmptyState icon={Search} title="Nothing in this folder matches that." />}
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

function Superseded() {
  return (
    <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
      superseded
    </Badge>
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
          <ItemTitle className="w-full">
            <span className="truncate">{doc.title}</span>
            {doc.superseded_by.length > 0 ? <Superseded /> : null}
          </ItemTitle>
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
    <EmptyState
      className="h-full min-h-60"
      icon={FileText}
      title="Pick a document to preview it"
      description={
        count
          ? `${title} holds ${formatCount(count, "file")}. What you see here is read from disk, so it is current even while the index catches up.`
          : `The list fills in as the index syncs with ${title}.`
      }
      action={
        writable ? (
          <NewNote
            folder={folder}
            title={title}
            trigger={
              <Button variant="outline" size="sm">
                <Plus aria-hidden /> New note
              </Button>
            }
          />
        ) : undefined
      }
    />
  );
}

function NoSuchFolder({ name }: { name: string }) {
  return (
    <EmptyState
      className="h-full min-h-60"
      icon={FolderIcon}
      level={1}
      title={`There is no folder called ${name}`}
      description={
        <>
          It may have been renamed or deleted.{" "}
          <Link to="/" className="underline underline-offset-4">
            Open another folder
          </Link>
          .
        </>
      }
    />
  );
}

function DocPreview({
  folder,
  path,
  summary,
  docs,
  known,
}: {
  folder: string;
  path: string;
  summary: DocSummary | undefined;
  docs: DocSummary[] | undefined;
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
  const replacedBy = (doc.data?.superseded_by ?? summary?.superseded_by ?? []).map(
    (each) => docs?.find((d) => d.path === each) ?? { path: each, title: withinFolder(each) },
  );
  const hasBadges =
    tags.length > 0 || aliases.length > 0 || otherFields.length > 0 || replacedBy.length > 0;
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
              <CopyButton variant="outline" value={path} label="Copy path" />
              <DownloadDoc path={path} />
              {writable && doc.data ? (
                <ActionButton
                  variant="outline"
                  size="icon-sm"
                  label="Edit"
                  onClick={() => setEditing(true)}
                >
                  <Pencil aria-hidden />
                </ActionButton>
              ) : null}
              {writable && summary ? <RenameDoc path={path} /> : null}
              {writable && summary ? <DeleteDoc path={path} /> : null}
            </>
          }
          content={
            hasBadges ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {replacedBy.length > 0 ? (
                  // Search already leaves this note out; this is for whoever opened it anyway.
                  <p className="w-full text-muted-foreground text-sm">
                    <Badge variant="outline" className="mr-1.5 font-normal">
                      superseded
                    </Badge>
                    by{" "}
                    {replacedBy.map((next, index) => (
                      <span key={next.path}>
                        {index > 0 ? ", " : null}
                        <Link
                          to="/f/$folder"
                          params={{ folder }}
                          search={(prev) => ({ ...prev, doc: withinFolder(next.path) })}
                          className="font-medium text-foreground underline underline-offset-4"
                        >
                          {next.title}
                        </Link>
                      </span>
                    ))}
                  </p>
                ) : null}
                {aliases.length > 0 ? (
                  <span className="text-muted-foreground text-xs">
                    Also called {aliases.join(", ")}
                  </span>
                ) : null}
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" asChild>
                    <Link
                      to="/f/$folder"
                      params={{ folder }}
                      search={(prev) => ({ ...prev, tag })}
                      aria-label={`Show documents tagged #${tag}`}
                      className="hover:underline"
                    >
                      #{tag}
                    </Link>
                  </Badge>
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
          <>
            <MarkdownPreview content={parsed.body} path={path} known={known} />
            <Backlinks folder={folder} path={path} />
          </>
        )
      }
    />
  );
}

/** The note's file as it is on disk, front matter and all, saved under its own name. */
function DownloadDoc({ path }: { path: string }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <ActionButton
      variant="outline"
      size="icon-sm"
      label="Download .md"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        getFile(path)
          .then((blob) => {
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = path.split("/").pop() ?? "note.md";
            anchor.click();
            // After the click has handed the URL to the download, not before.
            setTimeout(() => URL.revokeObjectURL(url), 0);
          })
          .catch((error) => toast(error instanceof Error ? error.message : String(error), "error"))
          .finally(() => setBusy(false));
      }}
    >
      <Download aria-hidden />
    </ActionButton>
  );
}
