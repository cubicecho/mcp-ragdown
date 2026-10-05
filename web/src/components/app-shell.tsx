import { createLink, Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { ActionButton } from "@/components/action-button";
import { CreateFolder } from "@/components/folder-actions";
import { EmptyState } from "@/components/page";
import { QueryState } from "@/components/query-state";
import { BarNavItem, Sidebar, SidebarNavItem, SidebarSection } from "@/components/sidebar";
import { SidebarLayout } from "@/components/split-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  Folder,
  Library,
  Lock,
  Plug,
  Plus,
  Settings,
  UserRound,
} from "@/components/ui/icons";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { clearToken, requireAuth } from "@/lib/auth";
import { formatAgo, formatCount } from "@/lib/format";
import { useFolders, useStatus, useWritable } from "@/lib/queries";

/** The row, handed the router's `href` and click handler so it navigates without a reload. */
const SidebarLink = createLink(SidebarNavItem);
/** The same, for the bar that stands in for the sidebar on a narrow screen. */
const BarLink = createLink(BarNavItem);

/** What the index is doing, at the foot of the sidebar: the one thing every page wants to know. */
function IndexStatus() {
  const status = useStatus();
  const data = status.data;

  if (status.isPending) return <Skeleton className="h-8 w-full" />;
  if (!data) return <p className="text-destructive text-xs">Server unreachable</p>;

  const line = !data.ready
    ? "Loading the model…"
    : data.syncing
      ? "Indexing…"
      : data.last_sync
        ? `Synced ${formatAgo(Date.parse(data.last_sync.at))}`
        : data.role === "reader"
          ? "Reading another process's index"
          : "Idle";

  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <p className="flex items-center gap-1.5 font-medium" role="status">
        <Badge
          variant={data.ready && !data.syncing ? "success" : "warning"}
          className={data.ready && !data.syncing ? undefined : "animate-pulse"}
        />
        {line}
      </p>
      {data.ready ? (
        <p className="text-muted-foreground">
          {formatCount(data.files ?? 0, "file")} · {formatCount(data.chunks ?? 0, "chunk")}
        </p>
      ) : null}
      {data.embedder ? (
        <p className="truncate text-muted-foreground" title={data.docs_dir}>
          {data.embedder}
        </p>
      ) : null}
    </div>
  );
}

function LockButton() {
  const status = useStatus();
  if (!status.data?.auth_required) return null;
  return (
    <ActionButton
      variant="outline"
      size="icon-sm"
      label="Lock"
      hint="Forget the stored token"
      side="right"
      onClick={() => {
        clearToken();
        requireAuth();
      }}
    >
      <Lock aria-hidden />
    </ActionButton>
  );
}

/** Settings, at the foot of the sidebar; the theme is chosen there, under This device. */
function SettingsLink() {
  const matchRoute = useMatchRoute();
  return (
    <SidebarLink
      to="/settings"
      label="Settings"
      icon={<Settings />}
      active={Boolean(matchRoute({ to: "/settings", fuzzy: true }))}
    />
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 font-semibold text-sm tracking-tight">
      <Library className="size-4 shrink-0" aria-hidden />
      ragdown
    </div>
  );
}

/** Plug for a folder on MCP, a person for a human-only one: the one fact the rail adds. */
const markerOf = (mcp: boolean) => (mcp ? <Plug /> : <UserRound />);
const markerText = (mcp: boolean) => (mcp ? "on MCP" : "human-only");
const statusOf = (mcp: boolean) => ({ label: markerText(mcp), icon: markerOf(mcp) });

function Nav() {
  const matchRoute = useMatchRoute();
  const folders = useFolders();
  const navigate = useNavigate();
  const writable = useWritable();
  const list = folders.data?.folders ?? [];
  return (
    <SidebarSection
      as="nav"
      label="Main"
      title="Folders"
      action={
        writable ? (
          <CreateFolder
            trigger={
              <ActionButton variant="outline" size="icon-sm" label="Create folder" side="right">
                <Plus aria-hidden />
              </ActionButton>
            }
            onCreated={(folder) =>
              void navigate({ to: "/f/$folder", params: { folder: folder.name } })
            }
          />
        ) : undefined
      }
      status={
        <QueryState
          query={folders}
          what="the folders"
          count={list.length}
          compact
          rows={2}
          empty={<EmptyState compact title="No folders yet." className="px-2" />}
        />
      }
      content={list.map((folder) => (
        <SidebarLink
          key={folder.name}
          to="/f/$folder"
          params={{ folder: folder.name }}
          label={folder.title}
          icon={<Folder />}
          status={statusOf(folder.mcp)}
          count={folder.files}
          title={`${folder.title}: ${formatCount(folder.files, "file")}, ${markerText(folder.mcp)}`}
          active={Boolean(
            matchRoute({ to: "/f/$folder", params: { folder: folder.name }, fuzzy: true }),
          )}
        />
      ))}
    />
  );
}

/**
 * The sidebar's folder list, for narrow screens where the sidebar is hidden: a menu named after the
 * open folder. Making a folder stays in Settings there, one tap away.
 */
function FolderSwitcher() {
  const folders = useFolders();
  const matchRoute = useMatchRoute();
  const list = folders.data?.folders ?? [];
  const open = matchRoute({ to: "/f/$folder", fuzzy: true });
  const current = open ? list.find((folder) => folder.name === open.folder) : undefined;
  if (list.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="outline" size="sm" className="min-w-0 max-w-40 gap-1">
          <Folder aria-hidden />
          <span className="truncate">{current?.title ?? "Folders"}</span>
          <ChevronDown aria-hidden />
          <span className="sr-only">, switch folder</span>
        </Button>
      </MenuTrigger>
      <MenuContent align="start" className="max-h-80">
        {list.map((folder) => (
          <MenuItem
            key={folder.name}
            icon={markerOf(folder.mcp)}
            label={folder.title}
            trailing={folder.name === current?.name ? "✓" : formatCount(folder.files, "file")}
            link={<Link to="/f/$folder" params={{ folder: folder.name }} />}
          />
        ))}
        <MenuSeparator />
        <MenuItem icon={<Settings />} label="Manage folders" link={<Link to="/settings" />} />
      </MenuContent>
    </Menu>
  );
}

export function AppShell() {
  return (
    <SidebarLayout
      className="h-full w-full overflow-hidden bg-background text-foreground"
      sidebarPosition="start"
      sidebarWidth="auto"
      divider="none"
      // Under `md` the sidebar's furniture moves to a bar, the folder list into a menu.
      sidebarHideBelow="md"
      brand={<Brand />}
      nav={<FolderSwitcher />}
      navLabel="Main"
      action={
        <>
          <BarLink
            to="/settings"
            label="Settings"
            icon={<Settings />}
            activeProps={{ active: true }}
          />
          <LockButton />
        </>
      }
      sidebar={
        <Sidebar
          className="w-56"
          header={<Brand />}
          content={<Nav />}
          footerClassName="gap-3 px-4 py-3"
          footer={
            <>
              <IndexStatus />
              <div className="-mx-2 flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <SettingsLink />
                </div>
                <LockButton />
              </div>
            </>
          }
        />
      }
      content={
        <main className="h-full min-h-0 overflow-y-auto md:overflow-hidden">
          <Outlet />
        </main>
      }
    />
  );
}
