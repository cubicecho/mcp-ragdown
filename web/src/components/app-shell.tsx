import { createLink, Outlet, useMatchRoute } from "@tanstack/react-router";
import { ActionButton } from "@/components/action-button";
import { FileText, Library, Lock } from "@/components/app-icons";
import { Sidebar, SidebarNavItem, SidebarSection } from "@/components/sidebar";
import { SidebarLayout } from "@/components/split-layout";
import { ThemeToggle } from "@/components/theme-toggle";
import { Skeleton } from "@/components/ui/skeleton";
import { clearToken, requireAuth } from "@/lib/auth";
import { formatAgo, formatCount } from "@/lib/format";
import { useStatus } from "@/lib/queries";

const NAV = [{ to: "/", label: "Documents", icon: FileText }] as const;

/** The row, handed the router's `href` and click handler so it navigates without a reload. */
const SidebarLink = createLink(SidebarNavItem);

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
        <span
          aria-hidden
          className={
            data.ready && !data.syncing
              ? "size-1.5 rounded-full bg-emerald-500"
              : "size-1.5 animate-pulse rounded-full bg-amber-500"
          }
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
      variant="ghost"
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

function Brand() {
  return (
    <div className="flex items-center gap-2 font-semibold text-sm tracking-tight">
      <Library className="size-4 shrink-0" aria-hidden />
      ragdown
    </div>
  );
}

function Nav() {
  const matchRoute = useMatchRoute();
  return (
    // `Sidebar` is a complementary `<aside>` and draws no `<nav>`, so the navigation landmark the
    // rows belong to is added around the section here. See https://github.com/cubicecho/cubeui/issues/128
    <nav aria-label="Main">
      <SidebarSection
        content={NAV.map(({ to, label, icon: Icon }) => (
          <SidebarLink
            key={to}
            to={to}
            // Redundant beside `to`, but the prop is required.
            // See https://github.com/cubicecho/cubeui/issues/129
            href={to}
            label={label}
            icon={<Icon />}
            active={Boolean(matchRoute({ to }))}
          />
        ))}
      />
    </nav>
  );
}

export function AppShell() {
  return (
    <SidebarLayout
      className="h-full w-full overflow-hidden bg-background text-foreground"
      sidebarPosition="start"
      sidebarWidth="auto"
      stackBelow="never"
      divider="none"
      sidebar={
        <Sidebar
          // Hidden under `md` by class, because the sidebar has no narrow-width behaviour of its
          // own; the header bar in `content` stands in for it there. See https://github.com/cubicecho/cubeui/issues/127
          className="hidden w-56 md:flex"
          header={<Brand />}
          content={<Nav />}
          footerClassName="gap-3 px-4 py-3"
          footer={
            <>
              <IndexStatus />
              <div className="flex items-center gap-1">
                <div className="flex-1">
                  <ThemeToggle />
                </div>
                <LockButton />
              </div>
            </>
          }
        />
      }
      content={
        <div className="flex h-full min-w-0 flex-col">
          {/* Under `md` the sidebar's furniture moves to a bar: one destination needs no rail. */}
          <header className="flex items-center gap-2 border-b px-4 py-2 md:hidden">
            <Brand />
            <div className="ml-auto flex items-center gap-1">
              <LockButton />
              <div className="w-24">
                <ThemeToggle />
              </div>
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto md:overflow-hidden">
            <Outlet />
          </main>
        </div>
      }
    />
  );
}
